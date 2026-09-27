import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import { GatewayClient } from "../../packages/gateway-client/src/index.js";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayComputerStatus } from "../../src/gateway/desktop/computer-service.js";
import {
  parseComputerActResult,
  parseScreenSnapshotResult,
  type ComputerActResult,
} from "../../src/plugins/computer-use-contract.js";
import { killProcessTree } from "../../src/process/kill-tree.js";

const { values } = parseArgs({
  options: { artifacts: { type: "string" }, help: { type: "boolean", short: "h" } },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/dev/computer-use-gateway-live-proof.ts --artifacts <empty-dir>\nLinux only. Requires the built checkout, installed CUA driver artifacts, TigerVNC, XFCE, D-Bus, and Mousepad. Starts an isolated Gateway; needs no model credentials.",
  );
  process.exit(0);
}
assert.equal(process.platform, "linux", "This proof requires an isolated Linux host");
assert(values.artifacts, "--artifacts is required");
const artifacts = path.resolve(values.artifacts);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
await mkdir(artifacts, { recursive: true, mode: 0o700 });
assert.equal((await readdir(artifacts)).length, 0, "Artifact directory must be empty");

type JsonRecord = Record<string, unknown>;
type ProcessIdentity = { pid: number; startTime: string; state: string };
const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const candidate = record(entry);
        return candidate ? [candidate] : [];
      })
    : [];
const string = (value: unknown): string => (typeof value === "string" ? value : "");

async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    assert(fields[19], "Linux process stat did not include its start time");
    return { pid, state: fields[0]!, startTime: fields[19] };
  } catch (error) {
    if (record(error)?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function descendants(
  rootPid: number,
): Promise<Array<ProcessIdentity & { computer: boolean }>> {
  const result: Array<ProcessIdentity & { computer: boolean }> = [];
  const queue = [rootPid];
  for (const parent of queue) {
    let children: string;
    try {
      children = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8");
    } catch (error) {
      if (record(error)?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const value of children.trim().split(/\s+/u).filter(Boolean)) {
      const pid = Number(value);
      const identity = await processIdentity(pid);
      if (!identity) {
        continue;
      }
      const argv = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      result.push({ ...identity, computer: argv.includes("/computer.worker.") });
      queue.push(pid);
    }
  }
  return result;
}

async function isStillRunning(identity: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  return current?.startTime === identity.startTime && current.state !== "Z";
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(
    path.join(artifacts, name),
    `${JSON.stringify(value, (key, entry) => (key === "base64" ? undefined : entry), 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

async function saveImage(
  name: string,
  image: { base64?: string; format?: string },
): Promise<string> {
  assert(
    image.base64 && (image.format === "png" || image.format === "jpeg"),
    `${name} has no CUA image`,
  );
  const filename = `${name}.${image.format}`;
  await writeFile(path.join(artifacts, filename), Buffer.from(image.base64, "base64"), {
    flag: "wx",
    mode: 0o600,
  });
  return filename;
}

function editor(state: ComputerActResult) {
  const observation = state.observation;
  assert(observation?.observationId, "Window state has no observation reference");
  const elements = [...(observation.elements ?? [])].filter((element) =>
    /text.?area|text.?field|^(?:text|entry|edit|editable text)$/iu.test(element.role),
  );
  elements.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
  assert(
    elements[0],
    "Mousepad has no accessible text editor; inspect the saved window observation",
  );
  return { element: elements[0], observationId: observation.observationId };
}

// openclaw-temp-dir: allow live proof owns a disposable installation and HOME, not operator state.
const scratch = await mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-computer-proof-"));
const token = randomBytes(32).toString("hex");
const redact = (value: string) => value.replaceAll(token, "[isolated Gateway token]");
const failures: string[] = [];
const evidence: JsonRecord = {
  route: "persistent operator RPC -> Gateway computer -> CUA",
  nodeCount: null,
};
const ownedProcesses = new Map<number, ProcessIdentity>();
const interrupted = new AbortController();
const onInterrupt = () => interrupted.abort(new Error("Live proof interrupted"));
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);
let logs = "";
let client: GatewayClient | undefined;
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let execution: { id: string; generation: string } | undefined;
let sequence = 0;
let connectionCount = 0;
let connectionClosed = false;
let stopping = false;

const phase = (message: string) => console.log(`[gateway-computer-proof] ${message}`);
const captureProcesses = async () => {
  assert(child?.pid);
  const found = await descendants(child.pid);
  for (const process of found) {
    ownedProcesses.set(process.pid, process);
  }
  return found;
};
const rpc = async <T>(method: string, params: JsonRecord = {}): Promise<T> => {
  interrupted.signal.throwIfAborted();
  assert(
    client && connectionCount === 1 && !connectionClosed,
    "Original operator connection is unavailable",
  );
  return await client.request<T>(method, params, { timeoutMs: 90_000, signal: interrupted.signal });
};
const invoke = async (
  command: "screen.snapshot" | "computer.act",
  fields: JsonRecord,
): Promise<unknown> => {
  assert(execution);
  const result = await rpc<{ payload: unknown }>("computer.invoke", {
    command,
    generation: execution.generation,
    params: { ...fields, executionId: execution.id },
    timeoutMs: 60_000,
    idempotencyKey: `live-proof-${++sequence}`,
  });
  return result.payload;
};
const act = async (action: string, fields: JsonRecord = {}) => {
  const result = parseComputerActResult(await invoke("computer.act", { action, ...fields }));
  assert(result.ok, `CUA ${action} did not succeed`);
  return result;
};
const closeExecution = async () => {
  if (!execution) {
    return;
  }
  assert(
    client && !connectionClosed,
    "Cannot close execution without its original operator connection",
  );
  await client.request(
    "computer.invoke",
    {
      command: "computer.act",
      generation: execution.generation,
      params: { action: "__close_execution", executionId: execution.id, reason: "live-proof" },
      timeoutMs: 60_000,
      idempotencyKey: `close-${execution.id}`,
    },
    { timeoutMs: 90_000 },
  );
  execution = undefined;
};

try {
  const port = await freePort();
  const configPath = path.join(scratch, "openclaw.json");
  const config: OpenClawConfig = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
      controlUi: { enabled: false },
    },
    desktop: { host: { enabled: true, managed: true } },
    plugins: { allow: ["cua-computer"], entries: { "cua-computer": { enabled: true } } },
    agents: {
      defaults: { workspace: path.join(scratch, "workspace"), heartbeat: { every: "0m" } },
    },
    cron: { enabled: false },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: path.join(scratch, "home"),
    OPENCLAW_HOME: path.join(scratch, "home"),
    OPENCLAW_STATE_DIR: path.join(scratch, "state"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
    XDG_CONFIG_HOME: path.join(scratch, "xdg-config"),
    XDG_CACHE_HOME: path.join(scratch, "xdg-cache"),
    XDG_DATA_HOME: path.join(scratch, "xdg-data"),
    XDG_RUNTIME_DIR: path.join(scratch, "xdg-runtime"),
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
  };
  for (const directory of [
    env.HOME,
    env.OPENCLAW_STATE_DIR,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.XDG_RUNTIME_DIR,
    path.join(scratch, "workspace"),
  ]) {
    assert(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  phase("starting isolated Gateway with managed desktop and no node");
  child = spawn(process.execPath, ["scripts/run-node.mjs", "gateway", "run"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendLog = (chunk: Buffer) => {
    logs = (logs + chunk.toString("utf8")).slice(-2 * 1024 * 1024);
  };
  child.stdout?.on("data", appendLog);
  child.stderr?.on("data", appendLog);
  exited = new Promise((resolve, reject) => {
    child!.once("error", reject);
    child!.once("close", (code, signal) => resolve({ code, signal }));
  });
  let resolveHello!: () => void;
  const hello = new Promise<void>((resolve) => {
    resolveHello = resolve;
  });
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    env,
    deviceIdentity: null,
    clientName: GATEWAY_CLIENT_IDS.CLI,
    clientDisplayName: "Isolated computer proof",
    mode: "cli",
    scopes: ["operator.read", "operator.write"],
    onHelloOk: () => {
      connectionCount++;
      resolveHello();
    },
    onConnectError: (error) => {
      logs += `\nclient: ${redact(error.message)}\n`;
    },
    onClose: () => {
      if (connectionCount > 0 && !stopping) {
        connectionClosed = true;
        client?.stop();
      }
    },
  });
  client.start();
  await bounded(
    Promise.race([
      hello,
      exited.then((outcome) => {
        throw new Error(`Gateway exited before connection (${outcome.code ?? outcome.signal})`);
      }),
    ]),
    180_000,
    "Gateway connection",
  );
  let computer: GatewayComputerStatus | undefined;
  const readyDeadline = Date.now() + 180_000;
  while (!computer) {
    try {
      computer = await rpc<GatewayComputerStatus>("computer.status");
    } catch (error) {
      if (
        !String(error).includes("unavailable during gateway startup") ||
        Date.now() >= readyDeadline
      ) {
        throw error;
      }
      await delay(500, undefined, { signal: interrupted.signal });
    }
  }
  assert(
    computer.configured && computer.available && computer.computerUse,
    computer.error ?? "Gateway computer is unavailable",
  );
  assert.equal(computer.computerUse.provider.id, "cua-computer");
  execution = { id: randomUUID(), generation: computer.computerUse.provider.generation };
  evidence.provider = computer.computerUse.provider;
  const nodes = await rpc<{ nodes: unknown[] }>("node.list");
  assert(Array.isArray(nodes.nodes));
  assert.equal(nodes.nodes.length, 0, "Proof Gateway unexpectedly has paired or connected nodes");
  evidence.nodeCount = nodes.nodes.length;
  const initial = parseScreenSnapshotResult(
    await invoke("screen.snapshot", { format: "png", maxWidth: 1280 }),
  );
  evidence.desktopImage = await saveImage("desktop", initial);
  phase("CUA captured the managed desktop; launching Mousepad through discovered app reference");
  const apps = records((await act("list_apps")).details?.apps);
  const app = apps.find((entry) => /mousepad/iu.test(string(entry.name)));
  assert(app && string(app.app), "CUA did not discover installed Mousepad in list_apps");
  await act("launch_app", { app: app.app });
  let window: JsonRecord | undefined;
  const windowDeadline = Date.now() + 30_000;
  while (!window && Date.now() < windowDeadline) {
    window = records((await act("list_windows")).details?.windows).find((entry) =>
      /mousepad/iu.test(`${string(entry.appName)} ${string(entry.title)}`),
    );
    if (!window) {
      await delay(250, undefined, { signal: interrupted.signal });
    }
  }
  assert(window && string(window.windowRef), "Mousepad did not expose a CUA window reference");
  const windowRef = window.windowRef;
  await act("bring_to_front", { windowRef });
  const before = await act("get_window_state", { windowRef, includeScreenshot: true });
  await writeJson("window-before.json", before);
  assert(before.observation);
  evidence.beforeImage = await saveImage("window-before", before.observation);
  const beforeEditor = editor(before);
  await act("left_click", {
    windowRef,
    elementRef: beforeEditor.element.elementRef,
    observationId: beforeEditor.observationId,
    deliveryMode: "foreground",
  });
  const focused = editor(await act("get_window_state", { windowRef, includeScreenshot: false }));
  const marker = `OpenClaw Gateway CUA proof ${randomUUID()}`;
  await act("type", {
    windowRef,
    elementRef: focused.element.elementRef,
    observationId: focused.observationId,
    deliveryMode: "foreground",
    text: marker,
  });
  const after = await act("get_window_state", { windowRef, includeScreenshot: true });
  await writeJson("window-after.json", after);
  assert(after.observation);
  evidence.afterImage = await saveImage("window-after", after.observation);
  const observedEditor = editor(after).element;
  assert(
    [observedEditor.value, observedEditor.label].some((value) => string(value).includes(marker)),
    "Fresh CUA accessibility state did not contain the typed marker",
  );
  evidence.marker = marker;
  evidence.window = { appName: window.appName, title: window.title };
  evidence.typedMarkerReadBack = true;
  const helpers = (await captureProcesses()).filter((entry) => entry.computer);
  assert.equal(helpers.length, 1, "Expected one owned Gateway computer helper");
  const helperTree = [helpers[0]!, ...(await descendants(helpers[0]!.pid))];
  const oldGeneration = execution.generation;
  phase("typed marker verified; closing native helper and checking generation fencing");
  await closeExecution();
  for (const member of helperTree) {
    assert(
      !(await isStillRunning(member)),
      `Native helper process ${member.pid} remained alive after execution close returned`,
    );
  }
  evidence.helperJoinedOnClose = true;
  const replacement = await rpc<GatewayComputerStatus>("computer.status");
  assert(
    replacement.available && replacement.computerUse,
    replacement.error ?? "Replacement computer failed",
  );
  assert.notEqual(replacement.computerUse.provider.generation, oldGeneration);
  execution = { id: randomUUID(), generation: replacement.computerUse.provider.generation };
  await invoke("screen.snapshot", { format: "png", maxWidth: 640 });
  await assert.rejects(
    rpc("computer.invoke", {
      command: "computer.act",
      generation: oldGeneration,
      params: { action: "type", executionId: execution.id, text: "STALE INPUT MUST NOT RUN" },
      idempotencyKey: "stale-generation-proof",
    }),
    /COMPUTER_STALE_OBSERVATION/u,
  );
  evidence.newGeneration = replacement.computerUse.provider.generation;
  evidence.staleGenerationRejected = true;
  await captureProcesses();
  await closeExecution();
} catch (error) {
  failures.push(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
} finally {
  phase("joining isolated execution and Gateway cleanup");
  if (child?.pid) {
    try {
      await captureProcesses();
    } catch (error) {
      failures.push(`process inventory: ${redact(String(error))}`);
    }
  }
  try {
    await closeExecution();
  } catch (error) {
    failures.push(`execution cleanup: ${redact(String(error))}`);
  }
  stopping = true;
  try {
    await client?.stopAndWait({ timeoutMs: 10_000 });
  } catch (error) {
    failures.push(`operator connection cleanup: ${redact(String(error))}`);
  }
  if (child && exited) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    try {
      evidence.gatewayExit = await bounded(exited, 45_000, "Gateway CLI shutdown");
      const remaining = (
        await Promise.all(
          [...ownedProcesses.values()].map(async (identity) =>
            (await isStillRunning(identity)) ? identity.pid : undefined,
          ),
        )
      ).filter((pid) => pid !== undefined);
      assert.equal(remaining.length, 0, `Owned processes still running: ${remaining.join(", ")}`);
      evidence.gatewayCleanupJoined = true;
    } catch (error) {
      failures.push(`Gateway cleanup: ${redact(String(error))}`);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        killProcessTree(child.pid, { force: true, detached: false });
        try {
          await bounded(exited, 10_000, "Forced proof Gateway cleanup");
          evidence.forcedGatewayCleanup = true;
        } catch (cleanupError) {
          failures.push(`forced cleanup: ${redact(String(cleanupError))}`);
        }
      }
    }
  }
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onInterrupt);
  if (evidence.gatewayCleanupJoined === true) {
    await rm(scratch, { recursive: true, force: true });
  } else {
    evidence.retainedState = scratch;
  }
  await writeFile(path.join(artifacts, "gateway.log"), redact(logs), { flag: "wx", mode: 0o600 });
  await writeJson("result.json", { ...evidence, ok: failures.length === 0, failures });
  console.log(JSON.stringify({ ok: failures.length === 0, artifacts, failures }, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
