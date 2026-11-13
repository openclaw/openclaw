import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
/**
 * Synthetic node-tool surface proof through a built Gateway, its real WebSocket
 * node transport, and a loopback Anthropic-compatible provider. No hardware or
 * provider credentials are used. Only observation and execution cleanup are
 * accepted by the fixture node.
 *
 * Run after pnpm build:runtime:
 * node --import ./scripts/tsx.mjs scripts/perf/node-tool-availability.mjs <empty-artifact-directory>
 *
 * Acceptance: absent routes disappear without losing node discovery; known
 * online/offline routes retain their session prefix. Compare raw HTTP bodies
 * and deterministic operation counts, not wall time.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { stopChildProcess } from "../../test/helpers/stop-child-process.ts";
if (!process.argv[2]) {
  throw new Error("Provide an empty artifact directory");
}
const root = process.cwd(),
  out = path.resolve(process.argv[2]);
await fs.mkdir(out, { recursive: true });
if ((await fs.readdir(out)).length) {
  throw new Error("Artifact directory must be empty");
}
const state = path.join(out, "state"),
  workspace = path.join(out, "workspace"),
  home = path.join(out, "home");
for (const p of [state, workspace, home]) {
  await fs.mkdir(p, { recursive: true });
}
// Select only synthetic state before importing clients that own device identity.
for (const key of Object.keys(process.env)) {
  if (
    ![
      "PATH",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SYSTEMROOT",
      "WINDIR",
      "ComSpec",
    ].includes(key)
  ) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  HOME: home,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "dist/extensions"),
});
const { GatewayClient } = await import("../../src/gateway/client.ts");
const { acquireTestPortBlock } = await import("../../src/test-utils/port-claims.ts");
const claim = await acquireTestPortBlock({ offsets: [0, 1] });
const port = claim.port,
  providerPort = port + 1,
  token = "synthetic-node-route-proof";
let scenario = "no-target",
  requestCount = 0;
const captures = [],
  clients = [],
  issued = new Set(),
  outcomes = [],
  nodeInvocations = [],
  handlerErrors = [];
let gateway;

/** @param {unknown} error */
function recordHandlerError(error) {
  handlerErrors.push(error);
  console.error(error);
}

// Locate serialized top-level values without reserializing them. Nested keys,
// escapes, and non-ASCII content remain in the provider's original UTF-8 bytes.
function rawProperty(raw, key) {
  const source = raw.toString("utf8");
  const endValue = (start) => {
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          quoted = false;
          if (depth === 0) {
            return i + 1;
          }
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === "[" || char === "{") {
        depth++;
      } else if (char === "]" || char === "}") {
        if (depth === 0) {
          return i;
        }
        if (--depth === 0) {
          return i + 1;
        }
      } else if (depth === 0 && (char === "," || /\s/.test(char))) {
        return i;
      }
    }
    throw new Error("Unterminated serialized provider value");
  };
  let cursor = 1;
  while (cursor < source.length) {
    while (/[\s,]/.test(source[cursor])) {
      cursor++;
    }
    if (source[cursor] === "}") {
      return Buffer.alloc(0);
    }
    const keyEnd = endValue(cursor),
      name = JSON.parse(source.slice(cursor, keyEnd));
    cursor = keyEnd;
    while (/[\s:]/.test(source[cursor])) {
      cursor++;
    }
    const end = endValue(cursor);
    if (name === key) {
      return Buffer.from(source.slice(cursor, end), "utf8");
    }
    cursor = end;
  }
  return Buffer.alloc(0);
}

function countImages(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }
  return (
    (value.type === "image" ? 1 : 0) +
    Object.values(value).reduce((n, item) => n + countImages(item), 0)
  );
}
async function handleProvider(req, res) {
  try {
    const chunks = [];
    for await (const c of req) {
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks),
      id = ++requestCount;
    await fs.writeFile(path.join(out, `${scenario}-${id}.http-body`), raw);
    const j = JSON.parse(raw.toString("utf8"));
    const system = rawProperty(raw, "system"),
      tools = rawProperty(raw, "tools");
    captures.push({
      scenario,
      id,
      rawBytes: raw.length,
      tools: (j.tools ?? []).map((t) => t.name),
      systemBytes: system.length,
      toolsBytes: tools.length,
      systemSha256: createHash("sha256").update(system).digest("hex"),
      toolsSha256: createHash("sha256").update(tools).digest("hex"),
      actionCounts: Object.fromEntries(
        (j.tools ?? []).map((tool) => [
          tool.name,
          tool.input_schema?.properties?.action?.enum?.length ?? 0,
        ]),
      ),
      inlineImages: countImages(j.messages),
    });
    const desired =
      scenario === "no-target"
        ? { name: "nodes", input: { action: "status" } }
        : scenario === "mobile"
          ? { name: "mobile_ui", input: { action: "observe" } }
          : { name: "computer", input: { action: "screenshot" } };
    const call =
      !issued.has(scenario) && (j.tools ?? []).some((t) => t.name === desired.name)
        ? desired
        : undefined;
    if (call) {
      issued.add(scenario);
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (e, d) => res.write("event: " + e + "\ndata: " + JSON.stringify(d) + "\n\n");
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_" + id,
        type: "message",
        role: "assistant",
        model: j.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: call
        ? { type: "tool_use", id: "toolu_" + id, name: call.name, input: {} }
        : { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: call
        ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) }
        : { type: "text_delta", text: "SYNTHETIC_NODE_ROUTE_DONE" },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    event("message_stop", { type: "message_stop" });
    res.end();
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
}
const provider = http.createServer((req, res) => {
  void handleProvider(req, res);
});
await new Promise((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(providerPort, "127.0.0.1", resolve);
});
await fs.writeFile(
  path.join(state, "openclaw.json"),
  JSON.stringify({
    models: {
      providers: {
        anthropic: {
          baseUrl: `http://127.0.0.1:${providerPort}`,
          apiKey: "synthetic-fixture-key",
          api: "anthropic-messages",
          models: [
            {
              id: "fixture-node-route",
              name: "Synthetic route fixture",
              input: ["text", "image"],
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: "anthropic/fixture-node-route" },
        workspace,
        skipBootstrap: true,
      },
    },
    tools: {
      codeMode: false,
      toolSearch: false,
      allow: ["nodes", "computer", "mobile_ui", "sessions_spawn", "automations"],
    },
    browser: { enabled: false },
    cron: { enabled: false },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      nodes: {
        commands: {
          allow: ["computer.act", "screen.snapshot", "mobile.ui.observe", "mobile.ui.act"],
        },
      },
    },
    plugins: { allow: ["anthropic"] },
  }),
);
const log = await fs.open(path.join(out, "gateway.log"), "w");
async function connect() {
  const { promise, resolve, reject } = Promise.withResolvers();
  const c = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    role: "operator",
    clientName: "test",
    clientDisplayName: "node-route-proof",
    clientVersion: "1.0.0",
    platform: process.platform,
    mode: "test",
    scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
    onHelloOk: () => resolve(c),
    onConnectError: reject,
  });
  clients.push(c);
  c.start();
  try {
    return await withTimeout(promise, 3000, { createError: () => new Error("connect deadline") });
  } catch (e) {
    await c.stopAndWait({ timeoutMs: 1000 });
    throw e;
  }
}
try {
  gateway = spawn(process.execPath, ["dist/entry.js", "gateway", "--allow-unconfigured"], {
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_TEST_FAST: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
    },
    stdio: ["ignore", log.fd, log.fd],
  });
  await fs.writeFile(
    path.join(out, "runtime.json"),
    JSON.stringify(
      {
        gatewayPid: gateway.pid,
        gatewayPort: port,
        providerPort,
        nodeVersion: process.version,
      },
      null,
      2,
    ),
  );
  let control;
  const deadline = Date.now() + 60000;
  while (!control) {
    try {
      control = await connect();
    } catch (e) {
      if (Date.now() > deadline || gateway.exitCode !== null || gateway.signalCode !== null) {
        throw e;
      }
      await delay(200);
    }
  }
  async function turn(name, key = name) {
    scenario = name;
    const ack = await control.request(
      "agent",
      {
        sessionKey: "agent:main:dm:node-route-" + key,
        createSessionIfMissing: true,
        message:
          "SCENARIO=" + name + ". Synthetic route probe; return the scripted fixture result only.",
        deliver: false,
        idempotencyKey: randomUUID(),
        timeout: 60,
      },
      { timeoutMs: 90000 },
    );
    const outcome = await control.request(
      "agent.wait",
      { runId: ack.runId, timeoutMs: 90000 },
      { timeoutMs: 95000 },
    );
    outcomes.push({ scenario, ack, outcome });
    await fs.writeFile(path.join(out, "outcome.json"), JSON.stringify(outcomes, null, 2));
  }
  await turn("no-target");
  async function approvePending() {
    for (const owner of ["device", "node"]) {
      const pending = await control.request(owner + ".pair.list", {});
      for (const item of pending.pending ?? []) {
        await control.request(owner + ".pair.approve", { requestId: item.requestId });
      }
    }
  }
  let node;
  async function connectNode() {
    const { promise, resolve, reject } = Promise.withResolvers();
    const c = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      role: "node",
      clientName: "node-host",
      clientDisplayName: "synthetic-android-desktop",
      clientVersion: "1.0.0",
      platform: "android",
      mode: "node",
      caps: ["computer", "screen", "mobileUI"],
      commands: ["screen.snapshot", "computer.act", "mobile.ui.observe", "mobile.ui.act"],
      computerUse: {
        contractVersion: 2,
        provider: { id: "synthetic", label: "Synthetic", generation: "fixture-1" },
        actions: ["screenshot"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      },
      scopes: [],
      onHelloOk: () => resolve(c),
      onConnectError: reject,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request") {
          return;
        }
        void (async () => {
          const f = event.payload;
          nodeInvocations.push({
            command: f.command,
            params: f.params ?? (f.paramsJSON ? JSON.parse(f.paramsJSON) : undefined),
          });
          let payload;
          if (
            f.command === "computer.act" &&
            (f.params ?? JSON.parse(f.paramsJSON ?? "{}")).action === "__close_execution"
          ) {
            payload = { ok: true };
          } else if (f.command === "screen.snapshot") {
            payload = {
              format: "png",
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
              displayFrameId: "fixture-frame",
              width: 1,
              height: 1,
              screenIndex: 0,
            };
          } else if (f.command === "mobile.ui.observe") {
            payload = {
              snapshotId: "fixture-snapshot",
              package: "fixture.app",
              windowTitle: "Synthetic",
              nodes: [],
            };
          } else {
            throw new Error("Unexpected fixture device effect: " + f.command);
          }
          await c.request("node.invoke.result", {
            id: f.id,
            nodeId: f.nodeId,
            ok: true,
            payloadJSON: JSON.stringify(payload),
          });
        })().catch(recordHandlerError);
      },
    });
    clients.push(c);
    c.start();
    try {
      return await withTimeout(promise, 4000, {
        createError: () => new Error("node connect deadline"),
      });
    } catch (error) {
      await c.stopAndWait({ timeoutMs: 1000 });
      throw error;
    }
  }
  try {
    node = await connectNode();
  } catch (error) {
    if (error.details?.code !== "PAIRING_REQUIRED") {
      throw error;
    }
    await approvePending();
    node = await connectNode();
  }
  await approvePending();
  await fs.writeFile(
    path.join(out, "online-nodes.json"),
    JSON.stringify(await control.request("node.list", {}), null, 2),
  );
  await turn("online", "known");
  await turn("mobile");
  await node.stopAndWait({ timeoutMs: 1000 });
  await fs.writeFile(
    path.join(out, "offline-nodes.json"),
    JSON.stringify(await control.request("node.list", {}), null, 2),
  );
  await turn("offline", "known");
  await fs.writeFile(path.join(out, "captures.json"), JSON.stringify(captures, null, 2));
  await fs.writeFile(
    path.join(out, "node-invocations.json"),
    JSON.stringify(nodeInvocations, null, 2),
  );
  const noTarget = captures.filter((item) => item.scenario === "no-target" && item.tools.length);
  if (
    !noTarget.length ||
    noTarget.some(
      (item) =>
        !item.tools.includes("nodes") ||
        item.tools.includes("computer") ||
        item.tools.includes("mobile_ui"),
    )
  ) {
    throw new Error("Absent routes remained in the provider surface, or node discovery was lost");
  }
  if (handlerErrors.length) {
    throw new AggregateError(handlerErrors, "Synthetic node handler failed");
  }
  for (const [name, tool] of [
    ["no-target", "nodes"],
    ["online", "computer"],
    ["mobile", "mobile_ui"],
  ]) {
    const result = outcomes.find((item) => item.scenario === name)?.outcome;
    if (result?.status !== "ok" || !result.terminalReceipt?.successfulToolNames?.includes(tool)) {
      throw new Error(name + " did not complete the real " + tool + " tool");
    }
  }
  if (
    !captures.some((item) => item.scenario === "online" && item.tools.length && item.inlineImages)
  ) {
    throw new Error("Synthetic screenshot never reached the direct provider image path");
  }
  // Anthropic moves a cache breakpoint after the first tool response. Compare
  // the settled online prefix with the next turn, without normalizing either.
  const online = captures.findLast((item) => item.scenario === "online" && item.tools.length);
  const offline = captures.find((item) => item.scenario === "offline" && item.tools.length);
  if (
    online?.systemSha256 !== offline?.systemSha256 ||
    online?.toolsSha256 !== offline?.toolsSha256
  ) {
    throw new Error("Known-target session prefix changed on disconnect");
  }
  console.log(JSON.stringify({ outcomes, requests: captures, nodeInvocations }, null, 2));
} finally {
  await Promise.allSettled(clients.map((c) => c.stopAndWait({ timeoutMs: 1000 })));
  try {
    if (gateway) {
      await stopChildProcess(gateway, 5000);
    }
  } finally {
    provider.closeAllConnections();
    await new Promise((resolve) => {
      provider.close(resolve);
    });
    await log.close();
    await claim.release();
  }
}
process.exit(0);
