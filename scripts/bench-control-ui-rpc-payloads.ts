// Synthetic, compiled-Gateway route census; never connects to an operator Gateway.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, connect } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { buffer } from "node:stream/consumers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import {
  gatewayOriginScope,
  gatewayCredentialScope,
} from "../packages/gateway-client/src/gateway-origin-scope.ts";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.ts";
import { APP_ROUTE_IDS, pathForRoute, type RouteId } from "../ui/src/app-route-paths.ts";
import {
  evaluateControlUiContext,
  getControlUiContextHandle,
} from "../ui/src/test-helpers/control-ui-e2e-context.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
import { startEngineMeasurement } from "./lib/control-ui-engine-metrics.ts";
import { runControlUiFirstRunFlow } from "./lib/control-ui-first-run-flow.ts";
import { runControlUiFirstRunPluginVisits } from "./lib/control-ui-first-run-plugins.ts";
import {
  installControlUiPageObserver,
  resetControlUiPageObserver,
  finishControlUiPageObserver,
  readControlUiPageObserver,
} from "./lib/control-ui-page-observer.ts";
import { installControlUiRpcObserver } from "./lib/control-ui-rpc-observer.ts";
import { createControlUiWireLink } from "./lib/control-ui-wire-link.ts";
import { stopChild, stopGatewayGracefully } from "./lib/gateway-bench-child.ts";
import { getFreePort, requestProbeStatus } from "./lib/gateway-bench-probes.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writePluginFixtures,
} from "./lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    "compare-entry": { type: "string" },
    "fixture-source-root": { type: "string" },
    "compare-fixture-source-root": { type: "string" },
    "restart-gateway-per-sample": { type: "boolean", default: false },
    "fresh-browser": { type: "boolean", default: false },
    "fixture-now": { type: "string" },
    "cold-only": { type: "boolean", default: false },
    controlled: { type: "boolean", default: false },
    "routes-only": { type: "boolean", default: false },
    "boot-route": { type: "string", default: "new-session" },
    routes: {
      type: "string",
      default: "all",
    },
    engines: { type: "string", default: "chromium,webkit" },
    profile: { type: "string", default: "local" },
    "idle-ms": { type: "string", default: "5000" },
    trace: { type: "boolean", default: false },
    "server-profile": { type: "boolean", default: false },
    "no-rpc-observer": { type: "boolean", default: false },
    "observe-ms": { type: "string", default: "0" },
    "prepare-ms": { type: "string", default: "0" },
    samples: { type: "string", default: "1" },
    sessions: { type: "string", default: "12000" },
    agents: { type: "string", default: "40" },
    cron: { type: "string", default: "1000" },
    skills: { type: "string", default: "100" },
    plugins: { type: "string", default: "30" },
    stream: { type: "boolean", default: false },
    screenshots: { type: "boolean", default: false },
    "first-run": { type: "boolean", default: false },
    "first-run-layout": { type: "boolean", default: false },
    "first-run-plugins": { type: "boolean", default: false },
    "empty-plugin-installation": { type: "boolean", default: false },
    viewport: { type: "string", default: "desktop" },
    "viewport-width": { type: "string" },
    "cpu-throttle": { type: "string", default: "1" },
  },
});
assert(values.output, "--output is required (a fresh directory on the external disk)");
assert(["local", "remote"].includes(values.profile));
assert(["desktop", "mobile"].includes(values.viewport));
assert(
  values["viewport-width"] === undefined ||
    (Number.isInteger(Number(values["viewport-width"])) && Number(values["viewport-width"]) > 0),
);
assert(["1", "4"].includes(values["cpu-throttle"]));
if (values["first-run"]) {
  values["restart-gateway-per-sample"] = true;
}
assert(!values["server-profile"] || values["first-run"], "Server profiles require --first-run");
assert(
  !values["empty-plugin-installation"] || values["first-run"],
  "Empty plugins require --first-run",
);
if (values["compare-bundle-dir"]) {
  await compare();
  process.exit(process.exitCode ?? 0);
}
const commands = values.controlled ? createInterface({ input: process.stdin }) : undefined;
const commandIterator = commands?.[Symbol.asyncIterator]();
const bootRoute = APP_ROUTE_IDS.find((route) => route === values["boot-route"]);
assert(bootRoute, "Unknown --boot-route");
const routes = (
  values.routes === "all"
    ? APP_ROUTE_IDS.filter((id) => id !== bootRoute)
    : values.routes.split(",")
)
  .filter(Boolean)
  .map((id) => {
    const selectedRoute = APP_ROUTE_IDS.find((route) => route === id);
    assert(selectedRoute, `Unknown route: ${id}`);
    return selectedRoute;
  });
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
// Offline writers must use the schema owners that built this arm's Gateway.
const fixtureSourceRoot = path.resolve(
  values["fixture-source-root"] ?? path.dirname(path.dirname(entry)),
);
const fixtureSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: fixtureSourceRoot,
  encoding: "utf8",
}).trim();
const runtimeBuildInfo: { commit?: unknown } = JSON.parse(
  await readFile(path.join(path.dirname(entry), "build-info.json"), "utf8"),
);
assert.equal(
  fixtureSourceCommit,
  runtimeBuildInfo.commit,
  "Fixture source HEAD must match the selected runtime build-info commit",
);
const fixtureModule = (relativePath: string) =>
  pathToFileURL(path.join(fixtureSourceRoot, relativePath)).href;
const {
  generateTeamShapeFixture,
  parseTeamShapeOptions,
}: typeof import("./perf/team-shape-fixture.ts") = await import(
  fixtureModule("scripts/perf/team-shape-fixture.ts")
);
const {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
}: {
  OPENCLAW_AGENT_SCHEMA_VERSION: number;
  OPENCLAW_STATE_SCHEMA_VERSION: number;
} = await import(fixtureModule("src/state/openclaw-schema-versions.ts"));
const fixtureSource = {
  root: fixtureSourceRoot,
  commit: fixtureSourceCommit,
  schemaVersions: {
    agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    state: OPENCLAW_STATE_SCHEMA_VERSION,
  },
};
await mkdir(output, { recursive: false });
const port = await getFreePort();
const proxyPort = await getFreePort();
const providerPort = await getFreePort();
const root = path.join(output, "state");
const fixtureNow = Number(values["fixture-now"] ?? Date.now());
const fixtureOptions = parseTeamShapeOptions([
  "--state-dir",
  root,
  "--sessions",
  values.sessions,
  "--agents",
  values.agents,
  "--cron",
  values.cron,
  "--runs",
  "0",
  "--approvals",
  "0",
  "--projects",
  "0",
  "--transcript-mib",
  "0",
  "--long-transcript-entries",
  "120",
  "--long-transcript-sessions",
  "1",
  "--port",
  String(port),
  "--now",
  String(fixtureNow),
]);
const configPath = path.join(root, "openclaw.json");
if (values["first-run"]) {
  await mkdir(root);
} else {
  await generateTeamShapeFixture(fixtureOptions);
}
const config = values["first-run"]
  ? {
      agents: { entries: { main: {} } },
      discovery: { mdns: { mode: "off" } },
      update: { checkOnStart: false },
    }
  : JSON.parse(await readFile(configPath, "utf8"));
const token = "synthetic-rpc-payloads-token";
const url = `http://127.0.0.1:${values.profile === "local" ? port : proxyPort}`;
config.gateway = {
  ...config.gateway,
  // Authored auth marks onboarding complete. First-run auth belongs only to
  // this isolated launch environment so the real setup consent still appears.
  ...(values["first-run"] ? {} : { auth: { mode: "token", token } }),
  trustedProxies: ["127.0.0.1"],
  controlUi: { enabled: true, root: path.resolve(values["bundle-dir"]), allowedOrigins: [url] },
};
config.diagnostics = {
  enabled: true,
  ...(values["server-profile"] ? { flags: ["timeline", "profiler"] } : {}),
};
if (values["empty-plugin-installation"]) {
  values["first-run-plugins"] = true;
  // Activate the on-demand X UI without credentials or a configured account.
  config.channels = { x: { enabled: true } };
  config.plugins = {
    enabled: true,
    slots: { memory: "knowledge" },
    entries: {
      workboard: { enabled: true },
      x: { enabled: true },
      clawrouter: { enabled: true },
      knowledge: {
        enabled: true,
        config: { stores: { fresh: { label: "Fresh knowledge", agents: ["main"] } } },
      },
      // Even this opt-in installation must never dial the public relay.
      "mcp-relay": { enabled: true, config: { relayUrl: `http://127.0.0.1:${providerPort}` } },
    },
  };
}
if (!values["first-run"]) {
  config.session = { maintenance: { maxEntries: Number(values.sessions) * 2 } };
  const plugins = writePluginFixtures(root, { count: Number(values.plugins) });
  config.plugins = {
    enabled: true,
    allow: plugins.pluginIds,
    load: { paths: [plugins.pluginsDir] },
  };
  config.models = {
    mode: "replace",
    providers: Object.fromEntries(
      Array.from({ length: 10 }, (_unusedProvider, provider) => [
        `rpc-bench-${provider}`,
        {
          baseUrl: `http://127.0.0.1:${providerPort}/v1`,
          apiKey: "synthetic-unused-key",
          api: "openai-completions",
          models: Array.from({ length: 100 }, (_unusedModel, model) => ({
            id: `synthetic-${model}`,
            name: `Synthetic model ${provider}/${model}`,
            input: ["text"],
            reasoning: false,
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      ]),
    ),
  };
  config.agents.entries.main.model = { primary: "rpc-bench-0/synthetic-0" };
  for (let index = 0; index < Number(values.skills); index++) {
    const name = `rpc-skill-${index}`;
    const directory = path.join(root, "workspace", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic RPC inventory skill ${index}.\n---\n\n# ${name}\n\nSynthetic procedure.\n`,
    );
  }
  // Keep repository discovery inside the synthetic workspace, even when output is .artifacts/.
  execFileSync("git", ["init", "--quiet", path.join(root, "workspace")]);
}
await writeFile(configPath, JSON.stringify(config));
const cacheRoot = await mkdtemp(path.join(output, "cache-"));
const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    // Exclude PATH-installed AI CLIs; macOS app-bundle probes still run normally.
    ...(values["first-run"] ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : {}),
    XDG_CACHE_HOME: cacheRoot,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_PROFILE: `rpc-payloads-${port}`,
    OPENCLAW_BENCH_RPC_PORT: String(port),
    OPENCLAW_BENCH_RPC_PARENT: String(process.pid),
    OPENCLAW_BENCH_RPC_ENTRY: entry,
    OPENCLAW_GATEWAY_TOKEN: token,
    // Fresh homes must not discover the checkout containing the proof directory.
    ...(values["first-run"] ? { GIT_CEILING_DIRECTORIES: output } : {}),
    ...(values["server-profile"]
      ? {
          OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: path.join(output, "gateway-timeline.jsonl"),
          OPENCLAW_DIAGNOSTICS: "timeline,profiler",
          OPENCLAW_BENCH_SERVER_PROFILE: "1",
        }
      : {}),
  },
});
const seed = createHash("sha256").update("synthetic-rpc-payloads-device").digest();
const key = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
const identity = {
  version: 1,
  deviceId: createHash("sha256").update(publicKey).digest("hex"),
  publicKey: publicKey.toString("base64url"),
  privateKey: seed.toString("base64url"),
  createdAtMs: fixtureNow,
};
const previousEnv = process.env;
try {
  process.env = env;
  const { requestDevicePairing }: typeof import("../src/infra/device-pairing.js") = await import(
    fixtureModule("src/infra/device-pairing.ts")
  );
  const { approveDevicePairing }: typeof import("../src/infra/device-pairing-approval.js") =
    await import(fixtureModule("src/infra/device-pairing-approval.ts"));
  const scopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.pairing",
  ];
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    role: "operator",
    scopes,
  });
  assert.equal(
    (await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes }))?.status,
    "approved",
  );
  // Keep host account names and portraits out of synthetic first-run captures.
  const {
    ensureCanonicalGatewayOwnerProfile,
    setCanonicalUserProfileAvatar,
  }: typeof import("../src/state/user-profile-writes.js") = await import(
    fixtureModule("src/state/user-profile-writes.ts")
  );
  const owner = await ensureCanonicalGatewayOwnerProfile("Synthetic RPC operator", { env });
  await setCanonicalUserProfileAvatar(
    owner.id,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/CfcAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
    { env },
  );
  const {
    closeOpenClawStateDatabaseAsync,
    runOpenClawStateWriteTransaction,
  }: typeof import("../src/state/openclaw-state-db.js") = await import(
    fixtureModule("src/state/openclaw-state-db.ts")
  );
  if (!values["first-run"]) {
    const { recordCronRunInDatabase }: typeof import("../src/cron/store/run-history.kernel.js") =
      await import(fixtureModule("src/cron/store/run-history.kernel.ts"));
    const {
      cronRunLogEntryToDetail,
      cronRunStorageStatus,
    }: typeof import("../src/cron/run-history-detail.js") = await import(
      fixtureModule("src/cron/run-history-detail.ts")
    );
    const { cronStoreKey }: typeof import("../src/cron/store/key.js") = await import(
      fixtureModule("src/cron/store/key.ts")
    );
    const storeKey = cronStoreKey(path.join(root, "cron", "jobs.json"));
    // Exclusive offline fixture custody; the compiled Gateway has not started.
    runOpenClawStateWriteTransaction(({ db }) => {
      for (let i = 0; i < Number(values.cron) * 5; i++) {
        const jobId = `team-shape-cron-${i % Number(values.cron)}`;
        const endedAt = fixtureNow - i * 1000;
        const summary =
          `Synthetic result ${i}. ` + "A reproducible completed automation result. ".repeat(30);
        recordCronRunInDatabase(db, {
          storeKey,
          jobId,
          runId: `rpc-run-${i}`,
          agentId: "main",
          startedAt: endedAt - 100,
          endedAt,
          status: cronRunStorageStatus({ status: "ok" }),
          summary,
          detail: cronRunLogEntryToDetail(
            { jobId, action: "finished", ts: endedAt, status: "ok", summary },
            { storeKey },
          ),
        });
      }
    });
  }
  await closeOpenClawStateDatabaseAsync();
} finally {
  process.env = previousEnv;
}
const stopPreload = new URL("./lib/gateway-bench-stop-preload.mjs", import.meta.url);
stopPreload.searchParams.set("parentPid", String(process.pid));
stopPreload.searchParams.set("entry", entry);
const seedRoot = path.join(output, "seed-state");
if (values["restart-gateway-per-sample"]) {
  await cp(root, seedRoot, { recursive: true, mode: constants.COPYFILE_FICLONE });
}
let child: ReturnType<typeof spawn> | undefined;
async function startGateway() {
  if (values["restart-gateway-per-sample"]) {
    await rm(root, { recursive: true, force: true });
    await cp(seedRoot, root, { recursive: true, mode: constants.COPYFILE_FICLONE });
    await rm(cacheRoot, { recursive: true, force: true });
    await mkdir(cacheRoot);
  }
  const startupAt = performance.now();
  child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(
      entry,
      port,
      [
        "--import",
        fileURLToPath(new URL("./perf/gateway-ui-rpc-preload.mjs", import.meta.url)),
        "--import",
        stopPreload.href,
      ],
      "token",
    ),
    {
      env,
      cwd: path.dirname(path.dirname(entry)),
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const log = createWriteStream(path.join(output, "gateway.log"), { flags: "a" });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once("close", () => log.end());
  const result = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300000,
    isDone: () => interrupted || child?.exitCode !== null,
  });
  assert.equal(
    result.status,
    200,
    `Compiled Gateway did not start: ${path.join(output, "gateway.log")}`,
  );
  report.diagnostics.push({
    type: "gateway-ready",
    spawnedAtEpochMs: performance.timeOrigin + startupAt,
    readyAtEpochMs: performance.timeOrigin + performance.now(),
    startupMs: performance.now() - startupAt,
  });
}
async function stopGateway() {
  if (child) {
    try {
      await stopGatewayGracefully(child, 30000);
    } finally {
      await stopChild(child);
      child = undefined;
    }
  }
}
let interrupted = false;
let activeBrowser: Browser | undefined;
const interrupt = () => {
  interrupted = true;
  process.exitCode = 130;
  commands?.close();
  // Closing the browser releases pending Playwright waits into the teardown below.
  void activeBrowser?.close();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const up = createControlUiWireLink({
  latencyMs: values.profile === "remote" ? 50 : 0,
  megabitsPerSecond: values.profile === "remote" && !values["first-run"] ? 10 : 10000,
});
const down = createControlUiWireLink({
  latencyMs: values.profile === "remote" ? 50 : 0,
  megabitsPerSecond: values.profile === "remote" && !values["first-run"] ? 10 : 10000,
});
const proxy = createServer((socket) => {
  const target = connect(port, "127.0.0.1");
  socket.setNoDelay(true);
  target.setNoDelay(true);
  up.connect(socket, target, () => {});
  down.connect(target, socket, () => {});
});
async function control(
  action: "begin" | "end" | "profile-start" | "profile-stop",
  profilePath?: string,
  captureProcesses = false,
) {
  assert(child, "Gateway is not running");
  const activeChild = child;
  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      activeChild.off("message", receive);
      reject(new Error("Gateway observer timed out"));
    }, 10000);
    function receive(raw: unknown) {
      const message = raw as { id?: string; result?: unknown; error?: string };
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      activeChild.off("message", receive);
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.result);
      }
    }
    activeChild.on("message", receive);
    activeChild.send({
      channel: "gateway-ui-rpc-measure",
      action,
      id,
      countOps: false,
      ...(captureProcesses ? { captureProcesses: true } : {}),
      ...(profilePath ? { path: profilePath } : {}),
    });
  });
}
const selectors: Partial<Record<RouteId, string>> = {
  "new-session": ".new-session-page__message:not(:disabled)",
  sessions: "openclaw-sessions-page .data-table tbody tr:not(.session-skeleton-row) a",
  cron: ".cron-table__row .cron-table__name",
  agents: ".agents-refresh-btn:not(:disabled)",
  usage: 'openclaw-usage-page button[aria-label="Refresh"]:not(:disabled)',
  "skill-settings": '.skill-library-search input[name="library-search"]',
  "plugin-settings": ".plugins-settings-search input",
  "model-providers": ".model-providers__provider-list",
  appearance: ".settings-theme-grid [data-theme-id]",
};
async function ready(page: Page, route?: RouteId) {
  await page.locator("openclaw-app-shell").waitFor({ state: "attached", timeout: 60000 });
  const application = await getControlUiContextHandle(page);
  try {
    await page.waitForFunction((app) => app.gateway.snapshot.phase === "connected", application, {
      timeout: 90000,
    });
    if (route) {
      await page.waitForFunction(
        (app) => {
          const current = app.router.getState();
          return current.status !== "loading" && current.pendingMatches.length === 0;
        },
        application,
        { timeout: 90000 },
      );
      const matched = await application.evaluate((app) =>
        app.router.getState().matches.map((match) => match.routeId),
      );
      assert(matched.includes(route), `${route} redirected to ${matched.join(",")}`);
    }
  } finally {
    await application.dispose();
  }
  if (route && selectors[route]) {
    // Locator waits back off to 500 ms, which turns readiness into polling latency.
    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        if (!element || getComputedStyle(element).visibility !== "visible") {
          return false;
        }
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      },
      selectors[route]!,
      { polling: "raf", timeout: 90000 },
    );
  } else {
    await page.locator("openclaw-app-shell").waitFor({ state: "visible", timeout: 90000 });
  }
  const readyAt = performance.now();
  if (values["no-rpc-observer"]) {
    return readyAt;
  }
  // Readiness is route-specific above; settle records the remaining admitted RPC work separately.
  await page.waitForFunction(
    () => {
      const rows = window.openclawRpcPayloads!;
      const answered = new Set(
        rows
          .filter((row) => row.direction === "response")
          .map((row) => `${row.socketId}:${row.id}`),
      );
      return (
        (rows.length === 0 || performance.now() - rows.at(-1)!.atMs > 350) &&
        rows.every(
          (row) => row.direction !== "request" || answered.has(`${row.socketId}:${row.id}`),
        )
      );
    },
    undefined,
    { timeout: 90000 },
  );
  return readyAt;
}
const providerRequests: Array<{ path: string; startedAt: number; endedAt?: number }> = [];
const provider = createHttpServer((request, response) => {
  if (values["first-run"]) {
    const record = {
      path: request.url ?? "",
      startedAt: performance.now(),
      endedAt: undefined as number | undefined,
    };
    providerRequests.push(record);
    response.on("finish", () => {
      record.endedAt = performance.now();
    });
    void serveFirstRunProvider(request, response);
    return;
  }
  request.resume();
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = {
    id: "chatcmpl_synthetic_rpc",
    object: "chat.completion.chunk",
    created: 0,
    model: "synthetic-0",
  };
  let index = 0;
  const timer = setInterval(() => {
    if (index++ < 80) {
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "Synthetic streamed response. " }, finish_reason: null }] })}\n\n`,
      );
    } else {
      clearInterval(timer);
      response.end(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 80, total_tokens: 90 } })}\n\ndata: [DONE]\n\n`,
      );
    }
  }, 25);
  response.on("close", () => clearInterval(timer));
});

async function serveFirstRunProvider(request: IncomingMessage, response: ServerResponse) {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "synthetic-model", object: "model" }] }));
    return;
  }
  if (request.url !== "/v1/chat/completions") {
    request.resume();
    response.writeHead(404);
    response.end();
    return;
  }
  const body = JSON.parse((await buffer(request)).toString() || "{}");
  const completion = {
    id: "chatcmpl_first_run",
    object: "chat.completion",
    created: 0,
    model: "synthetic-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Synthetic first-run reply." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completion));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic first-run reply." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
}

async function installFirstRunReadiness(page: Page) {
  await page.addInitScript((traceLayout) => {
    const layouts: unknown[] = [];
    let previousLayout = "";
    const frameIds = new WeakMap<Element, number>();
    let nextFrameId = 0;
    function sampleLayout() {
      const shell = document.querySelector(".shell");
      const main = shell?.querySelector("main.content");
      if (main && !frameIds.has(main)) {
        frameIds.set(main, ++nextFrameId);
      }
      const wizard = document.querySelector(".model-setup-wizard");
      const dialog = wizard?.closest("dialog");
      const bounds = dialog?.getBoundingClientRect();
      const layout = {
        shell: shell?.className,
        columns: shell ? getComputedStyle(shell).gridTemplateColumns : null,
        main: main
          ? {
              id: frameIds.get(main),
              rect: (() => {
                const rect = main.getBoundingClientRect();
                return [rect.x, rect.y, rect.width, rect.height];
              })(),
            }
          : null,
        chat: [
          ".chat-pane-cache__pane--active .chat-thread",
          ".chat-pane-cache__pane--active textarea[aria-label='Chat composer']",
        ].map((selector) => {
          const rect = main?.querySelector(selector)?.getBoundingClientRect();
          return { selector, rect: rect ? [rect.x, rect.y, rect.width, rect.height] : null };
        }),
        wizard: wizard?.className,
        title: wizard?.querySelector("h2")?.textContent,
        dialog: bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : null,
        regions: wizard
          ? [...wizard.children].map((element) => {
              const rect = element.getBoundingClientRect();
              return { class: element.className, rect: [rect.x, rect.y, rect.width, rect.height] };
            })
          : [],
      };
      const serialized = JSON.stringify(layout);
      if (serialized !== previousLayout && layouts.length < 500) {
        layouts.push({ at: performance.now(), ...layout });
        previousLayout = serialized;
      }
      requestAnimationFrame(sampleLayout);
    }
    if (traceLayout) {
      requestAnimationFrame(sampleLayout);
    }
    const probe = {
      startedAt: 0,
      inputAt: null as number | null,
      readyAt: null as number | null,
      selector: '[data-auth-choice="custom-api-key"] button',
      frame: 0,
      start(selector: string) {
        cancelAnimationFrame(probe.frame);
        probe.selector = selector;
        probe.startedAt = performance.now();
        probe.inputAt = null;
        probe.readyAt = null;
        sample();
      },
    };
    function sample() {
      const element = document.querySelector<HTMLElement>(probe.selector);
      if (element?.checkVisibility() && !element.matches(":disabled,[aria-disabled=true]")) {
        probe.readyAt = performance.now();
      } else {
        probe.frame = requestAnimationFrame(sample);
      }
    }
    for (const type of ["pointerdown", "keydown", "input"]) {
      document.addEventListener(
        type,
        (event) => {
          if (event.isTrusted && probe.inputAt === null) {
            probe.inputAt = performance.now();
          }
        },
        true,
      );
    }
    Reflect.set(window, "firstRunReadiness", probe);
    Reflect.set(window, "firstRunLayouts", layouts);
    sample();
  }, values["first-run-layout"]);
  // The first measured step navigates; its new document starts at time origin.
  await page.evaluate(() => Reflect.set(window, "firstRunReadiness", { start() {} }));
}
const report: {
  fixture: unknown;
  profile: string;
  entry: string;
  fixtureSource: typeof fixtureSource;
  rpcObserver: boolean;
  serverProfile: boolean;
  restartGatewayPerSample: boolean;
  freshBrowser: boolean;
  fixtureNow: number;
  observations: unknown[];
  journeys: unknown[];
  diagnostics: unknown[];
  errors: unknown[];
} = {
  fixture: values["first-run"]
    ? {
        firstRun: true,
        emptyPluginInstallation: values["empty-plugin-installation"],
        sessions: 0,
        model: null,
        provider: "loopback synthetic",
      }
    : JSON.parse(await readFile(path.join(root, "team-shape-summary.json"), "utf8")),
  profile: values.profile,
  entry,
  fixtureSource,
  rpcObserver: !values["no-rpc-observer"],
  serverProfile: values["server-profile"],
  restartGatewayPerSample: values["restart-gateway-per-sample"],
  freshBrowser: values["fresh-browser"],
  fixtureNow,
  observations: [],
  journeys: [],
  diagnostics: [],
  errors: [],
};
try {
  await new Promise<void>((resolve) => {
    provider.listen(providerPort, "127.0.0.1", resolve);
  });
  if (!values["restart-gateway-per-sample"]) {
    await startGateway();
  }
  await new Promise<void>((resolve) => {
    proxy.listen(proxyPort, "127.0.0.1", resolve);
  });
  for (const engine of values.engines.split(",")) {
    if (interrupted) {
      break;
    }
    assert(engine === "chromium" || engine === "webkit" || engine === "firefox");
    assert(
      engine === "chromium" || values["cpu-throttle"] === "1",
      "CPU throttle requires Chromium",
    );
    const engineName = engine;
    const launchBrowser = () =>
      engine === "webkit"
        ? webkit.launch({ headless: true })
        : engine === "firefox"
          ? firefox.launch({ headless: true })
          : chromium.launch({
              headless: true,
              executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
            });
    let browser = await launchBrowser();
    activeBrowser = browser;
    try {
      for (let sample = 0; sample < Number(values.samples); sample++) {
        if (interrupted) {
          break;
        }
        if (commandIterator) {
          console.log(`RPC_WORKER ready ${engine} ${sample}`);
          const command = await commandIterator.next();
          if (command.done) {
            break;
          }
          assert.equal(command.value, "sample");
        }
        if (values["fresh-browser"] && sample > 0) {
          await browser.close();
          browser = await launchBrowser();
          activeBrowser = browser;
        }
        if (values["restart-gateway-per-sample"]) {
          await startGateway();
        }
        const context = await browser.newContext({
          viewport: {
            width: Number(values["viewport-width"] ?? (values.viewport === "mobile" ? 390 : 1440)),
            height: values.viewport === "mobile" ? 844 : 1000,
          },
          ...(values.viewport === "mobile"
            ? { hasTouch: true, ...(engine !== "firefox" ? { isMobile: true } : {}) }
            : {}),
          serviceWorkers: "block",
          // First-run's RTT profile is still a localhost operator. A remote
          // identity correctly cannot open the local custom-provider wizard.
          ...(values.profile === "remote" && !values["first-run"]
            ? { extraHTTPHeaders: { "x-forwarded-for": "198.51.100.10" } }
            : {}),
        });
        await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
        if (values["first-run"]) {
          await context.addInitScript(() => Reflect.set(Error, "stackTraceLimit", 80));
        }
        if (!values["no-rpc-observer"]) {
          await context.addInitScript({
            content: `(${installControlUiRpcObserver.toString()})();`,
          });
        }
        await context.addInitScript(
          ({ identity: deviceIdentity, key: storageKey, token: sessionToken }) => {
            localStorage.setItem("openclaw-device-identity-v1", JSON.stringify(deviceIdentity));
            sessionStorage.setItem(storageKey, sessionToken);
          },
          {
            identity,
            token,
            key: `${CONTROL_UI_TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(url.replace("http", "ws"))}`,
          },
        );
        const page = await context.newPage();
        let activePhase = "setup";
        if (values["cpu-throttle"] !== "1") {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", {
            rate: Number(values["cpu-throttle"]),
          });
        }
        page.on("pageerror", (error) => {
          report.errors.push({ engine, sample, error: error.message });
          console.error(`${engine} page error: ${error.message}`);
        });
        if (values["first-run"]) {
          page.on("framenavigated", (frame) => {
            if (frame !== page.mainFrame()) {
              return;
            }
            const location = new URL(frame.url());
            report.diagnostics.push({
              engine,
              sample,
              phase: activePhase,
              at: Date.now(),
              type: "navigation",
              path: location.pathname,
              queryKeys: [...location.searchParams.keys()],
            });
          });
          page.on("response", (response) => {
            const location = new URL(response.url());
            if (
              response.request().resourceType() === "document" ||
              location.pathname === "/index.html" ||
              location.pathname === "/__openclaw__/session-entry"
            ) {
              report.diagnostics.push({
                engine,
                sample,
                phase: activePhase,
                at: Date.now(),
                type: "document-response",
                path: location.pathname,
                status: response.status(),
                contentType: response.headers()["content-type"],
              });
            }
          });
          page.on("websocket", (socket) => {
            const record = (type: string) =>
              report.diagnostics.push({
                engine,
                sample,
                phase: activePhase,
                at: Date.now(),
                type,
                path: new URL(socket.url()).pathname,
              });
            record("websocket-open");
            socket.on("close", () => record("websocket-close"));
          });
          page.on("console", (message) => {
            if (message.type() === "error") {
              report.diagnostics.push({
                engine,
                sample,
                phase: activePhase,
                at: Date.now(),
                type: "console",
                text: message.text(),
              });
              if (message.text().startsWith("[openclaw] route render failed")) {
                report.errors.push({
                  engine,
                  sample,
                  stage: "render",
                  phase: activePhase,
                  error: message.text(),
                });
              }
            }
          });
          page.on("requestfailed", (request) => {
            report.diagnostics.push({
              engine,
              sample,
              phase: activePhase,
              at: Date.now(),
              type: "requestfailed",
              path: new URL(request.url()).pathname,
              error: request.failure()?.errorText,
            });
          });
        }
        async function measureFirstRun(
          name: string,
          action: () => Promise<unknown>,
          selector: string,
        ) {
          activePhase = name;
          await control("begin", undefined, values["server-profile"] && name === "first-load");
          const documentBefore = await page.evaluate(() => performance.timeOrigin);
          await resetControlUiPageObserver(page);
          const providerStart = providerRequests.length;
          const measurement = await startEngineMeasurement(page, engineName, {
            trace: values.trace,
          });
          await page.evaluate((readySelector) => {
            Reflect.get(window, "firstRunReadiness").start(readySelector);
          }, selector);
          const startedAt = performance.now();
          let error: string | undefined;
          const serverProfilePath =
            values["server-profile"] &&
            ["first-load", "first-message-reply", "second-message-reply"].includes(name)
              ? path.join(output, `${engine}-${sample}-${name}.cpuprofile`)
              : undefined;
          if (serverProfilePath) {
            await control("profile-start");
          }
          try {
            await action();
            await page.waitForFunction(
              () => Reflect.get(window, "firstRunReadiness").readyAt !== null,
              undefined,
              { polling: "raf", timeout: 120000 },
            );
            const documentAfter = await page.evaluate(() => performance.timeOrigin);
            assert(
              name === "first-load" || documentBefore === documentAfter,
              "The application replaced the document during this step; recovery is not a passing readiness sample",
            );
          } catch (cause) {
            error = String(cause);
          } finally {
            if (serverProfilePath) {
              await control("profile-stop", serverProfilePath);
            }
          }
          await finishControlUiPageObserver(page);
          const readiness = await page.evaluate(() => {
            const probe = Reflect.get(window, "firstRunReadiness");
            return { startedAt: probe.startedAt, inputAt: probe.inputAt, readyAt: probe.readyAt };
          });
          const layouts = values["first-run-layout"]
            ? await page.evaluate(() => Reflect.get(window, "firstRunLayouts"))
            : undefined;
          const metrics = await measurement.stop();
          const server = await control("end");
          const pageMetrics = await readControlUiPageObserver(
            page,
            readiness.startedAt,
            readiness.readyAt ?? undefined,
          );
          const records = await page.evaluate(() => window.openclawRpcPayloads?.splice(0) ?? []);
          const resources = await page.evaluate(
            (start) =>
              performance
                .getEntriesByType("resource")
                .filter((resource) => resource.startTime >= start)
                .map((timing) => {
                  // SAFETY: the resource entry category supplies the ResourceTiming fields.
                  const resource = timing as PerformanceResourceTiming;
                  return {
                    path: new URL(resource.name).pathname,
                    type: resource.initiatorType,
                    protocol: resource.nextHopProtocol,
                    startMs: resource.startTime - start,
                    endMs: resource.responseEnd - start,
                    encodedBytes: resource.encodedBodySize,
                    transferBytes: resource.transferSize,
                  };
                }),
            readiness.startedAt,
          );
          report.observations.push({
            engine,
            browserVersion: browser.version(),
            viewport: values.viewport,
            viewportWidth: page.viewportSize()?.width,
            cpuThrottle: Number(values["cpu-throttle"]),
            sample,
            name,
            ...(serverProfilePath ? { serverProfilePath } : {}),
            readyMs: readiness.readyAt === null ? null : readiness.readyAt - readiness.startedAt,
            applicationMs:
              readiness.readyAt === null || readiness.inputAt === null
                ? null
                : readiness.readyAt - readiness.inputAt,
            wallMs: performance.now() - startedAt,
            metrics,
            pageMetrics,
            layouts,
            resources,
            server,
            records,
            providerRequests: providerRequests.slice(providerStart),
            error,
            load: loadavg(),
          });
          await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
          if (values.screenshots && sample === 0) {
            await page.screenshot({
              path: path.join(output, `${engine}-${name}.png`),
              animations: "disabled",
            });
          }
          console.log(
            `${engine} ${name}: ${readiness.readyAt === null ? "unavailable" : (readiness.readyAt - readiness.startedAt).toFixed(1)} ms${error ? ` ERROR ${error}` : ""}`,
          );
          if (error) {
            throw new Error(error);
          }
        }
        async function measure(name: string, action: () => Promise<unknown>, route?: RouteId) {
          await control("begin");
          const measurement = await startEngineMeasurement(page, engineName, {
            trace: values.trace,
          });
          const start = performance.now();
          let error: string | undefined;
          let readyAt: number | undefined;
          try {
            await action();
            readyAt = await ready(page, route);
            // Minimum window from action start; first readiness remains a separate metric.
            const remaining = Number(values["observe-ms"]) - (performance.now() - start);
            if (remaining > 0) {
              await page.waitForTimeout(remaining);
            }
          } catch (cause) {
            error = String(cause);
          }
          const settledMs = performance.now() - start;
          const metrics = await measurement.stop();
          const server = await control("end");
          const records = await page.evaluate(
            () => Reflect.get(window, "openclawRpcPayloads") ?? [],
          );
          const rendered = await page.evaluate(() => ({
            title: document.title,
            text: document.querySelector(".content")?.textContent?.slice(0, 300),
            rows: document.querySelectorAll(".cron-table__row,.data-table tbody tr,.plugins-item")
              .length,
          }));
          report.observations.push({
            engine,
            sample,
            name,
            metrics,
            readyMs: readyAt === undefined ? undefined : readyAt - start,
            settledMs,
            server,
            records,
            rendered,
            load: loadavg(),
            error,
          });
          await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
          if (values.screenshots && sample === 0) {
            await page.screenshot({ path: path.join(output, `${engine}-${name}.png`) });
          }
          console.log(
            `${engine} ${name}: ${settledMs.toFixed(1)} ms${error ? ` ERROR ${error}` : ""}`,
          );
          await page.evaluate(() => {
            if (window.openclawRpcPayloads) {
              window.openclawRpcPayloads.length = 0;
            }
          });
        }
        try {
          if (values["first-run"]) {
            await installControlUiPageObserver(page);
            await installFirstRunReadiness(page);
            const journey = await runControlUiFirstRunFlow(page, {
              url,
              providerUrl: `http://127.0.0.1:${providerPort}`,
              measure: measureFirstRun,
              waitForGatewayReady: async () => {
                const deadline = performance.now() + 120_000;
                let unavailableAtEpochMs: number | undefined;
                while (performance.now() < deadline) {
                  if (interrupted) {
                    break;
                  }
                  const { status, errorKind } = await requestProbeStatus(port, "/readyz");
                  const observedAtEpochMs = performance.timeOrigin + performance.now();
                  if (
                    (status !== null && status !== 200) ||
                    errorKind === "econnrefused" ||
                    errorKind === "econnreset"
                  ) {
                    unavailableAtEpochMs ??= observedAtEpochMs;
                  } else if (status === 200 && unavailableAtEpochMs !== undefined) {
                    return { unavailableAtEpochMs, readyAtEpochMs: observedAtEpochMs };
                  }
                  await new Promise((resolve) => {
                    setTimeout(resolve, 100);
                  });
                }
                throw new Error(
                  unavailableAtEpochMs === undefined
                    ? "Gateway readiness probe never observed the announced restart become unavailable"
                    : "Gateway readiness probe did not recover after becoming unavailable",
                );
              },
            });
            const pluginVisits = values["first-run-plugins"]
              ? await runControlUiFirstRunPluginVisits(page, { url, measure: measureFirstRun })
              : undefined;
            report.journeys.push({ engine, sample, ...journey, pluginVisits });
            await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
          } else {
            if (values["routes-only"]) {
              await page.goto(`${url}${pathForRoute(bootRoute)}`);
              await ready(page, bootRoute);
              await page.waitForTimeout(Number(values["prepare-ms"]));
              await page.evaluate(() => {
                if (window.openclawRpcPayloads) {
                  window.openclawRpcPayloads.length = 0;
                }
              });
            } else {
              await measure(
                "cold-boot",
                () => page.goto(`${url}${pathForRoute(bootRoute)}`),
                bootRoute,
              );
              if (!values["cold-only"]) {
                await page.waitForFunction(
                  (storageKey) => localStorage.getItem(storageKey) !== null,
                  `openclaw.control.bootRecord.v1:${gatewayCredentialScope(url.replace("http", "ws"))}`,
                  { timeout: 60000 },
                );
                await measure("warm-boot", () => page.reload(), bootRoute);
              }
            }
            for (const route of routes) {
              await page.evaluate((phase) => {
                Reflect.set(window, "openclawRpcPhase", phase);
              }, route);
              await measure(
                route,
                () =>
                  evaluateControlUiContext(
                    page,
                    (app, targetRoute) => app.navigate(targetRoute),
                    route,
                  ),
                route,
              );
            }
            await page.evaluate(() => {
              Reflect.set(window, "openclawRpcPhase", "idle");
            });
            if (Number(values["idle-ms"]) > 0) {
              await measure("idle", () => page.waitForTimeout(Number(values["idle-ms"])));
            }
            if (values.stream) {
              await evaluateControlUiContext(page, (app) => app.navigate("new-session"));
              await ready(page, "new-session");
              await page.evaluate(() => {
                if (window.openclawRpcPayloads) {
                  window.openclawRpcPayloads.length = 0;
                }
                window.openclawRpcPhase = "streaming";
              });
              await measure("streaming", async () => {
                await page
                  .locator(".new-session-page__message")
                  .fill("Return the synthetic streamed response.");
                await page.locator(".new-session-page__message").press("Enter");
                await page
                  .getByText("Synthetic streamed response.", { exact: false })
                  .first()
                  .waitFor({ timeout: 120000 });
                await page.waitForFunction(
                  () =>
                    [...document.querySelectorAll(".chat-bubble:not(.streaming)")].some(
                      (bubble) =>
                        bubble.getAttribute("data-message-text")?.trim() ===
                          "Synthetic streamed response. ".repeat(80).trim() &&
                        (bubble
                          .querySelector(".chat-text")
                          ?.textContent?.match(/Synthetic streamed response\./g)?.length ?? 0) ===
                          80,
                    ) && !document.querySelector(".chat-bubble.streaming"),
                  undefined,
                  { timeout: 120000 },
                );
              });
            }
          }
        } catch (cause) {
          report.errors.push({ engine, sample, stage: "sample", error: String(cause) });
          if (values["first-run"]) {
            const document = await page
              .evaluate(() => ({
                path: location.pathname,
                title: window.document.title,
                text: window.document.body?.textContent?.slice(0, 1000),
                timeOrigin: performance.timeOrigin,
              }))
              .catch(() => null);
            report.diagnostics.push({
              engine,
              sample,
              phase: activePhase,
              at: Date.now(),
              type: "failed-document",
              document,
            });
          }
          await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
          if (values.screenshots) {
            try {
              await page.screenshot({
                path: path.join(output, `${engine}-sample-error.png`),
                timeout: 5000,
              });
            } catch (error) {
              console.error(`${engine} error screenshot unavailable: ${String(error)}`);
            }
          }
          if (!values["first-run"]) {
            throw cause;
          }
        } finally {
          await context.close();
          if (values["restart-gateway-per-sample"]) {
            if (!values["first-run"]) {
              await stopGateway();
            } else {
              try {
                await stopGateway();
              } catch (error) {
                // The owned process tree was terminated by stopGateway's finally.
                // Retain failed graceful shutdown as a failure, then restore the
                // independent cold seed for the next sample.
                report.errors.push({ engine, sample, stage: "shutdown", error: String(error) });
                await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
                console.error(`${engine} shutdown: ${String(error)}`);
              }
            }
          }
        }
        if (commandIterator) {
          console.log(`RPC_WORKER done ${engine} ${sample}`);
        }
      }
    } finally {
      await browser.close();
      activeBrowser = undefined;
    }
  }
} finally {
  commands?.close();
  up.close();
  down.close();
  proxy.close();
  provider.closeAllConnections();
  provider.close();
  try {
    await stopGateway();
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
if (report.errors.length > 0) {
  process.exitCode = 1;
}

/** Three isolated Gateway workers, one active sample at a time, rotating all positions. */
async function compare() {
  assert(values.output && values["compare-bundle-dir"]);
  const destination = path.resolve(values.output);
  await mkdir(destination, { recursive: false });
  const workers: {
    side: string;
    worker: ReturnType<typeof spawn>;
    wait: (marker: string) => Promise<void>;
    log: ReturnType<typeof createWriteStream>;
    lines: ReturnType<typeof createInterface>;
  }[] = [];
  const sides = ["base", "control", "head"] as const;
  const comparisonFixtureNow = values["fixture-now"] ?? String(Date.now());
  const interruptWorkers = () => {
    process.exitCode = 130;
    for (const { worker } of workers) {
      worker.kill("SIGTERM");
    }
  };
  process.on("SIGINT", interruptWorkers);
  process.on("SIGTERM", interruptWorkers);
  try {
    for (const side of sides) {
      const selectedFixtureSourceRoot =
        side === "head"
          ? values["fixture-source-root"]
          : (values["compare-fixture-source-root"] ??
            (values["compare-entry"] ? undefined : values["fixture-source-root"]));
      const childArgs = [
        "--output",
        path.join(destination, side),
        "--bundle-dir",
        path.resolve(side === "head" ? values["bundle-dir"] : values["compare-bundle-dir"]),
        "--entry",
        path.resolve(side === "head" ? values.entry : (values["compare-entry"] ?? values.entry)),
        "--fixture-now",
        comparisonFixtureNow,
        ...(selectedFixtureSourceRoot
          ? ["--fixture-source-root", path.resolve(selectedFixtureSourceRoot)]
          : []),
        "--engines",
        values.engines,
        "--routes",
        values.routes,
        "--samples",
        values.samples,
        "--profile",
        values.profile,
        "--boot-route",
        values["boot-route"],
        "--sessions",
        values.sessions,
        "--agents",
        values.agents,
        "--cron",
        values.cron,
        "--skills",
        values.skills,
        "--plugins",
        values.plugins,
        "--idle-ms",
        values["idle-ms"],
        "--controlled",
        "--viewport",
        values.viewport,
        "--cpu-throttle",
        values["cpu-throttle"],
        ...(values["first-run"] ? ["--first-run"] : []),
        ...(values["first-run-layout"] ? ["--first-run-layout"] : []),
        ...(values["viewport-width"] ? ["--viewport-width", values["viewport-width"]] : []),
        ...(values["first-run-plugins"] ? ["--first-run-plugins"] : []),
        ...(values["empty-plugin-installation"] ? ["--empty-plugin-installation"] : []),
        ...(values.screenshots ? ["--screenshots"] : []),
        ...(values.trace ? ["--trace"] : []),
        ...(values["server-profile"] ? ["--server-profile"] : []),
        ...(values.stream ? ["--stream"] : []),
        ...(values["routes-only"] ? ["--routes-only"] : []),
        ...(values["cold-only"] ? ["--cold-only"] : []),
        ...(values["no-rpc-observer"] ? ["--no-rpc-observer"] : []),
        "--observe-ms",
        values["observe-ms"],
        "--prepare-ms",
        values["prepare-ms"],
        ...(values["restart-gateway-per-sample"] ? ["--restart-gateway-per-sample"] : []),
        ...(values["fresh-browser"] ? ["--fresh-browser"] : []),
      ];
      const worker = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), ...childArgs],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const workerLog = createWriteStream(path.join(destination, `${side}.log`));
      worker.stdout.pipe(workerLog);
      worker.stderr.pipe(workerLog);
      const lines = createInterface({ input: worker.stdout });
      const markers: string[] = [];
      let notify: (() => void) | undefined;
      let failure: Error | undefined;
      lines.on("line", (line) => {
        if (line.startsWith("RPC_WORKER ")) {
          markers.push(line);
          notify?.();
        }
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          failure = new Error(`${side} worker exited ${code}; inspect ${side}.log`);
        }
        notify?.();
      });
      const wait = async (marker: string) => {
        while (!markers.includes(marker)) {
          if (failure) {
            throw failure;
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              notify = undefined;
              reject(new Error(`${side} timed out waiting for ${marker}`));
            }, 600000);
            notify = () => {
              clearTimeout(timer);
              notify = undefined;
              resolve();
            };
          });
        }
        markers.splice(markers.indexOf(marker), 1);
      };
      workers.push({ side, worker, wait, log: workerLog, lines });
    }
    const orders = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
      [2, 1, 0],
      [0, 2, 1],
      [1, 0, 2],
    ];
    for (const engine of values.engines.split(",")) {
      for (let sample = 0; sample < Number(values.samples); sample++) {
        await Promise.all(
          workers.map((worker) => worker.wait(`RPC_WORKER ready ${engine} ${sample}`)),
        );
        for (const index of orders[sample % orders.length]!) {
          const worker = workers[index]!;
          worker.worker.stdin!.write("sample\n");
          await worker.wait(`RPC_WORKER done ${engine} ${sample}`);
        }
        console.log(`${engine} rotated triplet ${sample + 1}/${values.samples}`);
      }
    }
    await Promise.all(
      workers.map(
        ({ worker }) =>
          new Promise<void>((resolve, reject) => {
            if (worker.exitCode !== null || worker.signalCode !== null) {
              if (worker.exitCode === 0) {
                resolve();
              } else {
                reject(new Error("worker failed"));
              }
            } else {
              worker.once("exit", (code) =>
                code === 0 ? resolve() : reject(new Error(`worker failed: ${code}`)),
              );
            }
          }),
      ),
    );
  } finally {
    for (const { worker } of workers) {
      worker.stdin?.end();
    }
    await Promise.all(
      workers.map(async ({ worker, lines, log: workerLog }) => {
        if (worker.exitCode === null && worker.signalCode === null) {
          await new Promise<void>((resolve) => {
            worker.once("exit", () => resolve());
          });
        }
        lines.close();
        workerLog.end();
      }),
    );
    process.off("SIGINT", interruptWorkers);
    process.off("SIGTERM", interruptWorkers);
  }
}
