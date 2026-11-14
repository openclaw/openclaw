// Full-feature comparison: actual Codex/native stdout, Gateway, WebSocket and production UI.
// Run with node --import ./scripts/tsx.mjs; inference alone is a deterministic local fixture.
// Required: --comparison-plan <json> --candidate-source <commit> --candidate-tree <tree>.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { registerSealedRuntimeProcessEntrypoints } from "../../src/infra/runtime-process-url.ts";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.ts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../../ui/src/test-helpers/control-ui-browser-pairing.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  resolvePlaywrightChromiumExecutablePath,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { prepareGatewayMatrixProcessOwner } from "../lib/code-mode-matrix-process-owner.ts";
import { summarizeInteractionTrace } from "../lib/control-ui-interaction-trace.ts";
import { readGatewayMemory, readProcessTreeCpuMs } from "../lib/gateway-bench-probes.ts";
import { readProcessCgroupV2Snapshot, readProcessMemoryCapacity } from "../lib/process-memory.mts";
import { createNativeCommandProvider } from "./inline-command-native-provider.mjs";
import { installInlineCommandOptInProbe } from "./inline-command-opt-in-probe.mjs";
import { installInlineCommandRenderCounters } from "./inline-command-render-counters.mjs";
import { createTypingDiagnostics } from "./inline-command-typing-diagnostics.mjs";

const { values } = parseArgs({
  options: {
    candidate: { type: "string", default: process.cwd() },
    pairs: { type: "string", default: "20" },
    output: { type: "string" },
    "candidate-source": { type: "string" },
    "candidate-tree": { type: "string" },
    "work-counters": { type: "boolean", default: false },
    "startup-trace": { type: "boolean", default: false },
    "gateway-profile": { type: "boolean", default: false },
    "comparison-plan": { type: "string" },
  },
});
assert(values["comparison-plan"], "--comparison-plan must declare the pinned comparison");
const comparisonBytes = await readFile(values["comparison-plan"]);
const comparisonPlan = JSON.parse(comparisonBytes.toString());
assert.equal(process.platform, "linux", "Use the approved isolated Linux proof host");
const pairs = Number(values.pairs);
const workCounters = values["work-counters"];
const startupTrace = values["startup-trace"];
const gatewayProfile = values["gateway-profile"];
assert(
  !(gatewayProfile && workCounters),
  "Gateway profiles and render counters are separate diagnostics",
);
if (!workCounters && !gatewayProfile) {
  assert(Number.isInteger(pairs) && pairs >= 5 && pairs <= 60, "Declare 5–60 matched rounds");
} else {
  assert.equal(pairs, 1, "Use one separate diagnostic round");
}
assert(!startupTrace || (!workCounters && !gatewayProfile), "Keep attribution modes separate");
assert.match(values["candidate-source"] ?? "", /^[a-f0-9]{40}$/u, "freeze candidate source first");
assert.match(values["candidate-tree"] ?? "", /^[a-f0-9]{40}$/u, "freeze candidate tree first");
const startupTraceMode = "prewarm-native-frame-gc-v3";
const traceCategories =
  "toplevel,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,blink.user_timing" +
  ",cc,viz,disabled-by-default-cc.debug.scheduler,v8,disabled-by-default-v8.gc";
const attribution = workCounters || gatewayProfile;
const root = createControlUiE2eArtifactDir("inline-gateway", values.output);
const json = (name, value) => writeFile(path.join(root, name), JSON.stringify(value, null, 2));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const providerId = "inline-native-fixture";
const modelId = "gpt-5.4";
const producer = fileURLToPath(new URL("./inline-command-native-producer.mjs", import.meta.url));
const cells = (await import("./inline-command-opt-in-analysis.mjs")).comparisonPlanCells(
  comparisonPlan,
  {
    cwd: path.resolve(values.candidate),
    source: values["candidate-source"],
    tree: values["candidate-tree"],
  },
);
for (const cell of cells) {
  cell.commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: cell.cwd,
    encoding: "utf8",
  }).trim();
  const html = await readFile(path.join(cell.cwd, "dist/control-ui/index.html"));
  cell.indexSha256 = sha(html);
  cell.runtimeBuild = JSON.parse(
    await readFile(path.join(cell.cwd, "dist/build-info.json"), "utf8"),
  );
  cell.runtimeEntrySha256 = sha(await readFile(path.join(cell.cwd, "dist/index.js")));
  cell.sourceCommit = cell.source;
  assert.equal(cell.commit, cell.sourceCommit, "checkout must match the selected exact source");
  cell.liveOutputExpected = cell.inline;
  cell.tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: cell.cwd,
    encoding: "utf8",
  }).trim();
  assert.equal(cell.tree, comparisonPlan.cells.find((entry) => entry.label === cell.label).tree);
  if (cell.role === "candidate") {
    assert.equal(
      cell.tree,
      values["candidate-tree"],
      "candidate transport tree must equal reviewed source tree",
    );
  }
  assert.equal(
    cell.runtimeBuild.commit,
    cell.sourceCommit,
    "Gateway runtime must identify selected original source",
  );
  cell.build = JSON.parse(
    html.toString().match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)[1],
  );
  assert.equal(
    cell.build.commit,
    cell.sourceCommit,
    "UI build must identify selected original source",
  );
  const require = createRequire(path.join(cell.cwd, "extensions/codex/package.json"));
  const codexPackage = require.resolve("@openai/codex/package.json");
  cell.codexVersion = JSON.parse(await readFile(codexPackage, "utf8")).version;
  assert.equal(cell.codexVersion, "0.164.0", "all revisions must use the pinned native binary");
  cell.launcher = path.join(path.dirname(codexPackage), "bin/codex.js");
  cell.launcherSha256 = sha(await readFile(cell.launcher));
  assert.equal(process.arch, "x64", "This workload pins the Linux x64 native package");
  const nativeRequire = createRequire(codexPackage);
  cell.binary = path.join(
    path.dirname(nativeRequire.resolve("@openai/codex-linux-x64/package.json")),
    "vendor/x86_64-unknown-linux-musl/bin/codex",
  );
  cell.binarySha256 = sha(await readFile(cell.binary));
  cell.nativeVersion = execFileSync(cell.launcher, ["--version"], { encoding: "utf8" }).trim();
  assert(cell.nativeVersion.includes(cell.codexVersion));
}
for (const cell of cells) {
  assert.equal(cell.launcherSha256, cells[0].launcherSha256);
  assert.equal(cell.binarySha256, cells[0].binarySha256);
}

// The source-loaded driver needs the built kernel owner, shared across all cells.
// Loading the owner through tsx would invalidate its exclusive child-wait contract.
registerSealedRuntimeProcessEntrypoints(
  "serviceChildRelay",
  await prepareGatewayMatrixProcessOwner(path.resolve(values.candidate), root),
);

function resources() {
  return {
    at: new Date().toISOString(),
    load: os.loadavg(),
    cpus: os.availableParallelism(),
    memory: readProcessMemoryCapacity({}),
    cgroup: readProcessCgroupV2Snapshot(),
    affinity: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1],
    limits: readFileSync("/proc/self/limits", "utf8"),
    cgroupMembership: readFileSync("/proc/self/cgroup", "utf8"),
    cgroupMounts: readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter((line) => line.includes(" - cgroup2 ")),
    cpu: readFileSync("/proc/stat", "utf8").split("\n")[0],
  };
}
function readProc(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/u);
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rss = /^VmRSS:\s+(\d+)/mu.exec(status);
  return {
    pid,
    stat,
    startTicks: fields[19],
    rssKiB: rss ? Number(rss[1]) : null,
    status,
    cgroupMembership: readFileSync(`/proc/${pid}/cgroup`, "utf8"),
  };
}
function readGatewayProcessCgroups(rootPid, commandPid, browserPid) {
  assert(Number.isInteger(rootPid) && rootPid > 0, "Gateway custody root is required");
  const children = new Map();
  for (const line of execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/u).map(Number);
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  const descendants = (startPid) => {
    const selected = new Set();
    const pending = [startPid];
    while (pending.length) {
      const pid = pending.pop();
      if (!selected.has(pid)) {
        selected.add(pid);
        pending.push(...(children.get(pid) ?? []));
      }
    }
    return selected;
  };
  const custodyPids = descendants(rootPid);
  const commandPids = descendants(commandPid);
  const browserPids = browserPid ? descendants(browserPid) : new Set();
  const processes = [];
  for (const pid of new Set([...custodyPids, ...browserPids])) {
    try {
      processes.push(readProc(pid));
    } catch (error) {
      if (
        pid !== rootPid &&
        pid !== browserPid &&
        (error.code === "ENOENT" || error.code === "ESRCH")
      ) {
        processes.push({ pid, exitedDuringSnapshot: true });
      } else {
        throw error;
      }
    }
  }
  // One inventory covers custody/browser helpers while retaining command-only attribution.
  return {
    commandTree: processes.filter((entry) => commandPids.has(entry.pid)),
    custodyTree: processes.filter((entry) => custodyPids.has(entry.pid)),
    browserTree: processes.filter((entry) => browserPids.has(entry.pid)),
  };
}
const beforeIdle = resources();
await json("resource-before-admission.json", beforeIdle);
await delay(6000);
const afterIdle = resources();
await json("resource-after-admission.json", afterIdle);
// This proof requires full visible v2 ancestry; hidden ancestors are unknown.
assert(afterIdle.cgroupMounts.some((line) => line.split(" - ")[0].split(" ")[3] === "/"));
assert(afterIdle.cgroup?.length > 0, "cgroup v2 accounting is required");
let effectiveCpus = afterIdle.cpus;
for (const group of afterIdle.cgroup) {
  const quota = group.counters["cpu.max"];
  assert(quota !== null || group.directory === "/sys/fs/cgroup", "non-root CPU quota unavailable");
  if (quota) {
    const [amount, period] = quota.trim().split(/\s+/u);
    if (amount !== "max") {
      effectiveCpus = Math.min(effectiveCpus, Number(amount) / Number(period));
    }
  }
}
const throttle = (snapshot) =>
  snapshot.cgroup.map((group) => {
    const reading = group.counters["cpu.stat"]?.match(/^nr_throttled\s+(\d+)$/mu)?.[1];
    const count = reading === undefined ? null : Number(reading);
    const quota = group.counters["cpu.max"]?.trim().split(/\s+/u)[0];
    assert(
      !quota || quota === "max" || Number.isFinite(count),
      `Finite-quota throttling counter unavailable: ${group.directory}`,
    );
    // The root may omit bandwidth accounting; retain unknown rather than claim zero.
    return { directory: group.directory, count };
  });
assert.deepEqual(
  throttle(beforeIdle),
  throttle(afterIdle),
  "CPU throttling during resource admission",
);
const ticks = (snapshot) => snapshot.cpu.trim().split(/\s+/u).slice(1).map(Number);
const left = ticks(beforeIdle),
  right = ticks(afterIdle);
const delta = right.map((value, index) => value - left[index]);
// Guest fields are already included in user/nice and must not be counted twice.
const total = delta.slice(0, 8).reduce((sum, value) => sum + value, 0);
assert(
  effectiveCpus >= 2 && afterIdle.memory.limitBytes >= 4 * 1024 ** 3,
  "insufficient qualified resources",
);
assert(
  delta[3] / total >= 0.8 && delta[7] / total <= 0.01,
  "host not quiet enough for the frozen comparison",
);
await json("plan.json", {
  pairs,
  cells,
  producerSha256: sha(await readFile(producer)),
  beforeIdle,
  afterIdle,
  idleFraction: delta[3] / total,
  stealFraction: delta[7] / total,
  trace: startupTrace,
  startupTrace: startupTrace ? startupTraceMode : null,
  causalDiagnostics: false,
  allocationDiagnostics: gatewayProfile,
  metricTimeDomain: "threadTicks",
  prototypeCompare: true,
  calibration: false,
  workCounters,
  latencyAttribution: false,
  setupSmoke: false,
  stdoutOptIn: true,
  optInQualification: false,
  comparisonContract: {
    id: comparisonPlan.contractId,
    planSha256: sha(comparisonBytes),
    manifestValidatorSha256: sha(
      await readFile(new URL("./inline-command-opt-in-analysis.mjs", import.meta.url)),
    ),
    cells: comparisonPlan.cells,
    qualification: false,
  },
  ...(gatewayProfile ? { gatewayProfile: true } : {}),
  acceptanceContract: {
    id: comparisonPlan.contractId,
    evaluation: "External contract decides acceptance",
  },
  readiness:
    "Accepted phase:start in existing run owner plus published and mounted command structure in every cell before producer-start. Startup frame/task observations retained separately.",
  control: cells.some((cell) => cell.control),
  instrumentation: startupTrace
    ? "Startup is instrumented with same-run CDP task, GC, cc/viz and compositor scheduler-state tracing through the existing explicit GC in every declared cell, then stopped and fully drained before baseline probes and warm activation. No CPU or allocation sampling. Trace collection and drain overhead remain in startup observations; warm residual effects are not assumed zero. Native records support individual attribution, never automatic tail exemptions. Warm thresholds and the full startup/warm tail gate are unchanged."
    : gatewayProfile
      ? "Diagnostic only: Node Gateway CPU and allocation sampling throughout its lifetime, with a monotonic warm bracket. No render counters or startup tracing. These samples cannot establish qualification."
      : !workCounters
        ? "Untraced matched comparison: existing WebSocket and typing observations; no owner render wrappers. Observation costs remain included. External prospective contract decides acceptance."
        : "Attribution only: owner render/lifecycle wrappers and traffic-dependent row DOM MutationObserver. These samples cannot establish CPU or latency acceptance.",
  boundary:
    "Actual Codex shell, production Gateway/WebSocket/UI; local deterministic Responses provider, no real inference latency. Native-WebSocket subclass attaches observation only, identically in all cells. Startup and final reconciliation excluded from warm output interval.",
  phase: gatewayProfile
    ? "gateway-profile"
    : workCounters
      ? "attribution"
      : "prospective-matched-comparison",
  effectiveCpus,
  clockTicksPerSecond: Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()),
  rule: "Explicit pinned upstream and same-source grouped/inline; optional original control remains an independent anchor. External contract decides acceptance. Historical verdicts unchanged.",
});
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
let browserCdp = null;
try {
  browserCdp = await browser.newBrowserCDPSession();
} catch (error) {
  await browser.close();
  throw error;
}
const samples = [];
const browserIdentity = { version: browser.version(), executablePath };
if (startupTrace) {
  const session = await browser.newBrowserCDPSession();
  try {
    browserIdentity.protocol = await session.send("Browser.getVersion");
  } finally {
    await session.detach();
  }
}
await json("browser.json", browserIdentity);
const metric = async (cdp) =>
  Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
  );
const waitForFile = async (filename) => {
  const deadline = Date.now() + 60_000;
  while (!existsSync(filename)) {
    assert(Date.now() < deadline, `missing producer receipt: ${path.basename(filename)}`);
    await delay(10);
  }
};

try {
  for (let pair = 0; pair < pairs; pair++) {
    // Pair each rotation with its reverse so neither revision leads more often.
    const offset = Math.floor(pair / 2) % cells.length;
    const order = [...cells.slice(offset), ...cells.slice(0, offset)];
    if (pair % 2) {
      order.reverse();
    }
    for (const cell of order) {
      const name = `${cell.label}-${pair}`;
      const cellDir = path.join(root, name);
      await mkdir(cellDir);
      const command = [process.execPath, producer, cellDir].map(shellQuote).join(" ");
      const provider = await createNativeCommandProvider(command);
      let instance, client, context, page, gatewayHello, disposeTrace;
      const errors = [];
      const prewarmOperations = [];
      const prewarmClockProbes = [];
      const lifecycleBefore = resources();
      const prewarm = async (operation, run) => {
        const entry = { operation, startHostMs: performance.now() };
        prewarmOperations.push(entry);
        try {
          const result = await run();
          entry.status = "complete";
          return result;
        } catch (error) {
          entry.status = "failed";
          throw error;
        } finally {
          entry.endHostMs = performance.now();
        }
      };
      try {
        await runQaGatewayFixture(
          async () => {
            try {
              instance = await createOpenClawTestInstance({
                name,
                cwd: cell.cwd,
                entrypoint: gatewayProfile
                  ? [
                      "--cpu-prof",
                      `--cpu-prof-dir=${cellDir}`,
                      "--heap-prof",
                      `--heap-prof-dir=${cellDir}`,
                      "dist/index.js",
                    ]
                  : ["dist/index.js"],
                env: {
                  VITEST: undefined,
                  OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
                  OPENCLAW_SKIP_PROVIDERS: undefined,
                  OPENAI_API_KEY: undefined,
                  CODEX_API_KEY: undefined,
                  CODEX_ACCESS_TOKEN: undefined,
                },
                config: {
                  gateway: { controlUi: { enabled: true } },
                  cron: { enabled: false },
                  browser: { enabled: false },
                  update: { checkOnStart: false },
                  models: {
                    mode: "replace",
                    catalogRefresh: { enabled: false },
                    providers: {
                      [providerId]: {
                        auth: "native-command",
                        api: "openai-responses",
                        baseUrl: provider.baseUrl,
                        agentRuntime: { id: "codex" },
                        models: [
                          {
                            id: modelId,
                            name: "Deterministic native command",
                            reasoning: true,
                            input: ["text"],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            contextWindow: 100000,
                            maxTokens: 1000,
                          },
                        ],
                      },
                    },
                  },
                  plugins: {
                    enabled: true,
                    allow: ["codex"],
                    entries: {
                      codex: {
                        enabled: true,
                        config: {
                          appServer: {
                            command: cell.launcher,
                            args: ["app-server"],
                            mode: "yolo",
                            sandbox: "danger-full-access",
                            codeModeOnly: false,
                            requestTimeoutMs: 90000,
                          },
                        },
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      model: { primary: `${providerId}/${modelId}`, fallbacks: [] },
                      skipBootstrap: true,
                      skills: [],
                      timeoutSeconds: 90,
                      sandbox: { mode: "off" },
                    },
                  },
                  tools: { profile: "full" },
                },
              });
              const ca = instance.state.path("fixture-ca.pem");
              await writeFile(ca, provider.certificate);
              instance.env.SSL_CERT_FILE = ca;
              const codexHome = path.join(instance.state.agentDir(), "codex-home");
              await mkdir(codexHome, { recursive: true });
              const tokenCommand = instance.state.path("native-token.mjs");
              await writeFile(
                tokenCommand,
                'process.stdout.write("synthetic-inline-native-token");\n',
              );
              await writeFile(
                path.join(codexHome, "config.toml"),
                [
                  `model=${JSON.stringify(modelId)}`,
                  `model_provider=${JSON.stringify(providerId)}`,
                  'cli_auth_credentials_store="ephemeral"',
                  'web_search="disabled"',
                  'approval_policy="never"',
                  'sandbox_mode="danger-full-access"',
                  "allow_login_shell=false",
                  "[features]",
                  "shell_snapshot=false",
                  "secret_auth_storage=true",
                  "[analytics]",
                  "enabled=false",
                  "[feedback]",
                  "enabled=false",
                  `[model_providers.${providerId}]`,
                  'name="Deterministic native provider"',
                  `base_url=${JSON.stringify(provider.baseUrl)}`,
                  'wire_api="responses"',
                  "requires_openai_auth=false",
                  "supports_websockets=false",
                  "request_max_retries=0",
                  "stream_max_retries=0",
                  `[model_providers.${providerId}.auth]`,
                  `command=${JSON.stringify(process.execPath)}`,
                  `args=[${JSON.stringify(tokenCommand)}]`,
                ].join("\n"),
              );
              await instance.startGateway();
              client = await acquireGatewayTestClient(
                {
                  url: instance.url,
                  token: instance.gatewayToken,
                  env: instance.env,
                  clientName: "cli",
                  mode: "cli",
                  scopes: ["operator.admin"],
                  onHelloOk: (hello) => {
                    gatewayHello = hello;
                  },
                  deviceIdentity: null,
                  deviceAuthScope: instance.url,
                  sharedStateMode: "read-only",
                },
                {
                  timeoutMs: 10000,
                  timeoutMessage: "native comparison client did not connect",
                  closeMessage: "native comparison client closed",
                },
              );
              assert.equal(
                gatewayHello.server.buildId,
                cell.build.buildId,
                "live Gateway must serve the selected UI build",
              );
              // Each revision owns its schema; never seed older cells with the driver's state writer.
              const { profile } = await client.request("users.self", {});
              await client.request("users.setDisplayName", {
                profileId: profile.id,
                displayName: "Synthetic comparison viewer",
              });
              await writeFile(
                path.join(cellDir, "gateway-identity.json"),
                JSON.stringify({
                  runtime: cell.runtimeBuild,
                  entrySha256: cell.runtimeEntrySha256,
                  hello: gatewayHello.server,
                }),
              );
              const key = "agent:main:dashboard:inline-native-comparison";
              await client.request("sessions.create", {
                key,
                agentId: "main",
                label: "Command streaming comparison",
                model: `${providerId}/${modelId}`,
              });
              await client.request("sessions.patch", { key, verboseLevel: "off" });
              context = await browser.newContext({
                viewport: { width: 1440, height: 1000 },
                locale: "en-US",
              });
              page = await context.newPage();

              await page.addInitScript(installInlineCommandOptInProbe);

              if (workCounters) {
                await page.addInitScript(installInlineCommandRenderCounters);
              }
              page.setDefaultTimeout(30000);
              page.on("pageerror", (error) => errors.push(error.message));
              await page.addInitScript(
                ({ storageKey, inline }) => {
                  localStorage.setItem(storageKey, JSON.stringify({ chatInlineCommands: inline }));
                  const state = {
                    frames: [],
                    startupFrames: [],
                    subscriptionRequests: [],
                    nextFrameId: 0,
                    requestJoinOverflow: false,
                    recoveryActive: false,
                    recoveryRequests: [],
                    recoveryResponses: [],
                    stdoutOptIn: true,
                    requests: [],
                    active: false,
                    rafGaps: [],
                    tasks: [],
                    previousFrame: null,
                    observePreview: inline,
                    previewFinalAt: null,
                  };
                  window.inlineNativeProbe = state;
                  const NativeWebSocket = window.WebSocket;
                  window.WebSocket = class extends NativeWebSocket {
                    #requestMethods = new Map();
                    constructor(...args) {
                      super(...args);
                      const observeMessage = (event) => {
                        if (typeof event.data !== "string") {
                          return;
                        }

                        const envelope = JSON.parse(event.data);
                        const requestMethod =
                          envelope.type === "res"
                            ? this.#requestMethods.get(envelope.id)
                            : undefined;
                        if (envelope.type === "res") {
                          this.#requestMethods.delete(envelope.id);
                        }
                        if (state.recoveryActive) {
                          const request = state.recoveryRequests.find(
                            (entry) => entry.id === envelope.id,
                          );
                          if (envelope.type === "res" && request) {
                            state.recoveryResponses.push({
                              id: envelope.id,
                              method: request.method,
                              ok: envelope.ok,
                              at: performance.now(),
                              hasFinalMarker: JSON.stringify(envelope.payload ?? null).includes(
                                "output-000511:",
                              ),
                            });
                          }
                        }
                        if (!state.active && !window.inlineCommandOptInProbe?.active) {
                          return;
                        }
                        const data = envelope.payload;
                        const output = data?.stream === "tool" ? data.data : undefined;
                        const text =
                          output?.partialResult?.liveOutput?.text ??
                          output?.partialResult?.text ??
                          "";
                        const indices = [...text.matchAll(/output-(\d{6}):/g)].map((match) =>
                          Number(match[1]),
                        );
                        const frame = {
                          frameId: ++state.nextFrameId,
                          requestId: envelope.id,
                          requestMethod,
                          at: performance.now(),
                          bytes: new TextEncoder().encode(event.data).length,
                          event: envelope.event,
                          type: envelope.type,
                          stream: data?.stream,
                          phase: output?.phase,
                          runId: data?.runId,
                          seq: data?.seq,
                          toolCallId: output?.toolCallId,
                          outputOnly: output?.outputOnly === true,
                          outputBodyBytes: new TextEncoder().encode(
                            (output?.partialResult?.text ?? "") +
                              (output?.partialResult?.liveOutput?.text ?? ""),
                          ).length,
                          minIndex: indices.length ? Math.min(...indices) : null,
                          maxIndex: indices.length ? Math.max(...indices) : null,
                        };

                        window.inlineCommandOptInProbe.recordMessageFrame(event, frame);

                        (state.active ? state.frames : state.startupFrames).push(frame);
                      };

                      window.inlineCommandOptInProbe.listenObserver(this, observeMessage);
                    }
                    send(data) {
                      if (typeof data === "string") {
                        const request = JSON.parse(data);
                        if (typeof request.id === "string" && typeof request.method === "string") {
                          if (this.#requestMethods.size < 512) {
                            this.#requestMethods.set(request.id, request.method);
                          } else {
                            state.requestJoinOverflow = true;
                          }
                        }
                        if (request.method === "sessions.messages.subscribe") {
                          state.subscriptionRequests.push({
                            at: performance.now(),
                            sessionKey: request.params?.key,
                            includeLiveToolOutput: request.params?.includeLiveToolOutput === true,
                          });
                        }
                        if (
                          state.recoveryActive &&
                          ["sessions.messages.subscribe", "chat.history"].includes(request.method)
                        ) {
                          state.recoveryRequests.push({
                            id: request.id,
                            method: request.method,
                            key: request.params?.key ?? request.params?.sessionKey,
                            includeLiveToolOutput: request.params?.includeLiveToolOutput === true,
                            at: performance.now(),
                          });
                        }
                      }
                      if (state.active && typeof data === "string") {
                        const message = JSON.parse(data);
                        state.requests.push({
                          at: performance.now(),
                          method: message.method,
                          bytes: new TextEncoder().encode(data).length,
                        });
                      }
                      return super.send(data);
                    }
                  };
                },
                {
                  storageKey: controlUiBundledSettingsStorageKey(
                    `http://127.0.0.1:${instance.port}/`,
                  ),
                  inline: cell.inline,
                },
              );
              const cli = async (args) => {
                const result = await instance.cli(args);
                assert.equal(result.code, 0, result.stderr);
                return result.stdout;
              };
              await pairControlUiPage(page, cli);
              await page.goto(controlUiSessionUrl(`http://127.0.0.1:${instance.port}/`, key));
              const script = await page
                .locator('script[type="module"][src]')
                .first()
                .getAttribute("src");
              const served = await context.request.get(new URL(script, page.url()).href);
              assert(
                (await served.body()).equals(
                  await readFile(
                    path.join(cell.cwd, "dist/control-ui", script.replace(/^\//u, "")),
                  ),
                ),
                "served JS must match selected revision",
              );
              const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
              const composer = pane.getByRole("textbox", { name: "Chat composer", exact: true });
              const stop = pane.locator("button.chat-send-btn--stop");
              await composer.fill("Run the fixed native command streaming comparison.");
              let cdp;
              const trace = [];
              let traceActive = false;
              let traceReceipt;
              const collectTrace = ({ value }) => trace.push(...value);
              disposeTrace = () => cdp?.off("Tracing.dataCollected", collectTrace);
              const startTrace = async () => {
                cdp.on("Tracing.dataCollected", collectTrace);
                await cdp.send("Tracing.start", {
                  categories: traceCategories,
                  transferMode: "ReportEvents",
                });
                traceActive = true;
              };
              const stopTrace = async () => {
                assert(traceActive, "Trace must be active before draining");
                let timer, completed;
                const drained = new Promise((resolve, reject) => {
                  completed = resolve;
                  timer = setTimeout(() => reject(new Error("Trace drain timeout")), 10000);
                  cdp.once("Tracing.tracingComplete", completed);
                });
                try {
                  const [, completion] = await Promise.all([cdp.send("Tracing.end"), drained]);
                  assert.equal(
                    completion.dataLossOccurred,
                    false,
                    "Trace data loss invalidates capture",
                  );
                  traceActive = false;
                  return { completion, drainedHostMs: performance.now(), events: trace.length };
                } finally {
                  clearTimeout(timer);
                  cdp.off("Tracing.tracingComplete", completed);
                  disposeTrace();
                }
              };
              if (startupTrace) {
                cdp = await context.newCDPSession(page);
                await startTrace();
              }

              const sentAt = performance.now();
              const browserAt = await page.evaluate(() => window.inlineCommandOptInProbe.start());
              prewarmClockProbes.push({
                phase: "startup-start",
                sentAt,
                browserAt,
                receivedAt: performance.now(),
              });

              await prewarm("send-click-actionability-and-dispatch", () =>
                pane.getByRole("button", { name: "Send message", exact: true }).click(),
              );
              await prewarm("producer-ready-wait", () =>
                waitForFile(path.join(cellDir, "producer-ready")),
              );
              await prewarm("running-control-wait", () => stop.waitFor({ state: "visible" }));
              if (cell.inline) {
                await prewarm("inline-command-mount-wait", () =>
                  pane.locator(".chat-tool-row__cmd").waitFor({ state: "attached" }),
                );
              }

              await prewarm("accepted-owner-and-mounted-command-wait", () =>
                page.waitForFunction(
                  ({ sessionKey, inline }) =>
                    window.inlineCommandOptInProbe.ready(sessionKey, inline),
                  { sessionKey: key, inline: cell.inline },
                ),
              );
              if (cell.role === "candidate") {
                assert(
                  await prewarm("subscription-intent-readback", () =>
                    page.evaluate(
                      ({ sessionKey, inline }) =>
                        window.inlineNativeProbe.subscriptionRequests.some(
                          (request) =>
                            request.sessionKey === sessionKey &&
                            request.includeLiveToolOutput === inline,
                        ),
                      { sessionKey: key, inline: cell.inline },
                    ),
                  ),
                  "candidate must declare the selected live-output interest",
                );
              }

              await prewarm("composer-focus", () => composer.focus());
              const typing = await prewarm("typing-observers-and-clock-setup", () =>
                createTypingDiagnostics(page, composer, true),
              );
              if (workCounters) {
                await page.evaluate(() => window.inlineCommandRenderCounters.start());
              }
              await prewarm("cdp-performance-initialization", async () => {
                cdp ??= await context.newCDPSession(page);
                await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
              });
              // Keep the explicit GC inside native startup observation. Stop/drain
              // remains inside continuous callback observation and before warm baselines.
              await prewarm("explicit-renderer-gc", () => cdp.send("HeapProfiler.collectGarbage"));
              if (startupTrace) {
                const endBrowserMs = await prewarm("startup-trace-end-mark", () =>
                  page.evaluate(() => performance.mark("inline-prewarm-gc-trace-end").startTime),
                );
                const receipt = await prewarm("startup-trace-stop-and-drain", stopTrace);
                traceReceipt = {
                  mode: startupTraceMode,
                  requestedCategories: traceCategories.split(","),
                  endBrowserMs,
                  ...receipt,
                };
              }
              const gatewayProbe = async () => {
                const probe = {
                  atMs: performance.now(),
                  pid: instance.child.pid,
                  stat: readFileSync(`/proc/${instance.child.pid}/stat`, "utf8"),
                  ...(gatewayProfile
                    ? {
                        threads: readdirSync(`/proc/${instance.child.pid}/task`).flatMap((tid) => {
                          try {
                            return [
                              readFileSync(`/proc/${instance.child.pid}/task/${tid}/stat`, "utf8"),
                            ];
                          } catch (error) {
                            // A worker can exit between listing and reading its task.
                            if (error.code === "ENOENT" || error.code === "ESRCH") {
                              return [];
                            }
                            throw error;
                          }
                        }),
                      }
                    : {}),
                };

                const gatewayLiveTreeCpuMs = readProcessTreeCpuMs(instance.child.pid);
                const processInfo = (await browserCdp.send("SystemInfo.getProcessInfo"))
                  .processInfo;
                const browserRootPid = processInfo.find((entry) => entry.type === "browser")?.id;
                const { commandTree, custodyTree, browserTree } = readGatewayProcessCgroups(
                  instance.child.memoryRootPid,
                  instance.child.pid,
                  browserRootPid,
                );
                const osProcesses = new Map(
                  [...custodyTree, ...browserTree].map((entry) => [entry.pid, entry]),
                );
                const browserProcesses = processInfo.map((entry) => {
                  try {
                    return Object.assign(entry, osProcesses.get(entry.id) ?? readProc(entry.id));
                  } catch (error) {
                    if (error.code === "ENOENT" || error.code === "ESRCH") {
                      return Object.assign(entry, { pid: entry.id, exitedDuringSnapshot: true });
                    }
                    throw error;
                  }
                });
                const productProcesses = [...custodyTree, ...browserTree, ...browserProcesses];
                const missingProcesses = productProcesses
                  .filter((entry) => !entry.startTicks || !Number.isFinite(entry.rssKiB))
                  .map(({ pid, startTicks, exitedDuringSnapshot }) => ({
                    pid,
                    startTicks,
                    exitedDuringSnapshot: exitedDuringSnapshot === true,
                  }));
                const commandCovered = commandTree.some(
                  (entry) => entry.pid === instance.child.pid,
                );
                const identities = [
                  ...new Map(
                    productProcesses
                      .filter((entry) => entry.startTicks && Number.isFinite(entry.rssKiB))
                      .map((entry) => [`${entry.pid}:${entry.startTicks}`, entry]),
                  ).values(),
                ].map(({ pid, startTicks, rssKiB }) => ({ pid, startTicks, rssKiB }));
                const browserCovered = browserProcesses.some(
                  (entry) =>
                    entry.type === "browser" &&
                    browserTree.some((observed) => observed.pid === entry.id),
                );
                const identitiesStable =
                  new Set(identities.map((entry) => entry.pid)).size === identities.length;
                const complete =
                  commandCovered &&
                  browserCovered &&
                  identitiesStable &&
                  missingProcesses.length === 0;
                probe.processAccounting = {
                  gatewayLiveTreeCpuMs,
                  gatewayLiveTreeCompleteForExitedChildren: false,
                  gatewayProcessCgroups: commandTree,
                  gatewayCustodyRootPid: instance.child.memoryRootPid,
                  gatewayCustodyTree: custodyTree,
                  browserRootPid: browserRootPid ?? null,
                  browserOsTree: browserTree,
                  browserProcesses,
                  productRss: {
                    complete,
                    commandCovered,
                    browserCovered,
                    identitiesStable,
                    missingProcesses,
                    identities,
                    rssKiB: complete
                      ? identities.reduce((sum, entry) => sum + entry.rssKiB, 0)
                      : null,
                  },
                  enclosingCgroup: readProcessCgroupV2Snapshot(),
                  driverCpuUsage: process.cpuUsage(),
                  driverMemoryUsage: process.memoryUsage(),
                  interpretation:
                    "Command-root CPU and CDP process facts retain historical attribution. Product RSS counts the custody-root Gateway/native tree, browser OS tree and CDP-only PID/start identities once; missing observations make its total unknown. Driver/provider/probe memory is separate. RSS can double-count shared pages. Live PID CPU misses exited children; enclosing cgroup includes benchmark/background work and must not be added to process totals.",
                };

                probe.memory = await readGatewayMemory(
                  (method, params) => client.request(method, params),
                  0,
                );
                return probe;
              };
              const profileStartNs = gatewayProfile
                ? process.hrtime.bigint().toString()
                : undefined;
              const gatewayBefore = await prewarm("gateway-baseline-probe", gatewayProbe);
              const before = await prewarm("renderer-baseline-metrics", () => metric(cdp));
              await prewarm("warm-activation", () =>
                page.evaluate(() => {
                  const state = window.inlineNativeProbe;
                  state.active = true;
                  state.startAt = performance.now();
                  performance.mark("native-output-start");
                  window.inlineCommandOptInProbe.beginWarm();
                }),
              );
              if (startupTrace) {
                assert(!traceActive, "Tracing must be inactive before native writes");
                assert.equal(
                  trace.length,
                  traceReceipt.events,
                  "Trace changed after complete drain",
                );
              }
              // hrtime is the same Linux monotonic clock in the producer and driver.
              // Bracket its offset against driver performance.now(), then combine with
              // Playwright's bracketed browser probes; never subtract unrelated clocks.
              const clockCalibration = [];
              for (let probe = 0; probe < 3; probe++) {
                const beforeMs = performance.now();
                const monotonicMs = Number(process.hrtime.bigint()) / 1e6;
                clockCalibration.push({ beforeMs, monotonicMs, afterMs: performance.now() });
              }
              const intervalStart = performance.now();
              await writeFile(path.join(cellDir, "producer-start"), "start\n");
              for (let checkpoint = 0; checkpoint < 16; checkpoint++) {
                const deadline = intervalStart + checkpoint * 640;
                await delay(Math.max(0, deadline - performance.now()));
                await typing.measure(checkpoint * 32, checkpoint + 1);
              }
              if (workCounters) {
                await page.evaluate(() => window.inlineCommandRenderCounters.beginOutputOnly());
              }
              await waitForFile(path.join(cellDir, "producer-receipt.json"));
              const producerReceipt = JSON.parse(
                await readFile(path.join(cellDir, "producer-receipt.json"), "utf8"),
              );
              assert.equal(
                producerReceipt.sha256,
                "5c928ba18713ac641610b6b486d92ec35908c8374472d96f88dcf3df9e523ac5",
              );
              assert.equal(producerReceipt.chunks, 512);
              assert.equal(producerReceipt.chunkBytes, 4096);
              assert.equal(producerReceipt.intervalMs, 20);
              assert.equal(producerReceipt.receipts.length, 512);
              for (let index = 0; index < 512; index++) {
                const receipt = producerReceipt.receipts[index];
                assert.equal(receipt.index, index);
                assert.equal(receipt.plannedMs, index * 20);
                assert(BigInt(receipt.afterNs) >= BigInt(receipt.beforeNs));
                if (index) {
                  assert(
                    BigInt(receipt.beforeNs) >= BigInt(producerReceipt.receipts[index - 1].afterNs),
                  );
                }
              }
              // A completed pipe write does not acknowledge Gateway/browser delivery.
              // Include the final live update in both candidate measurement intervals.
              if (cell.liveOutputExpected) {
                await page.waitForFunction(() =>
                  window.inlineNativeProbe.frames.some(
                    (frame) =>
                      frame.stream === "tool" && frame.phase === "update" && frame.maxIndex === 511,
                  ),
                );
              }
              if (cell.inline) {
                await page.waitForFunction(() =>
                  document
                    .querySelector(".chat-command-trail__preview pre")
                    ?.textContent.includes("output-000511:"),
                );

                await page.waitForFunction(() => window.inlineNativeProbe.previewFinalAt !== null);
              }
              if (cell.inline) {
                assert(
                  (await pane.locator(".chat-tool-row--running").count()) > 0,
                  "latest preview must belong to a running command row",
                );
              }
              const after = await metric(cdp);
              const renderCounters = workCounters
                ? await page.evaluate(() => window.inlineCommandRenderCounters.finish())
                : null;
              const browserReceipt = await page.evaluate(() => {
                const state = window.inlineNativeProbe;
                const startup = window.inlineCommandOptInProbe.finish();
                state.active = false;
                state.endAt = performance.now();
                performance.mark("native-output-end");
                return {
                  frames: state.frames,
                  requests: state.requests,
                  rafGaps: state.rafGaps,
                  tasks: state.tasks,
                  startAt: state.startAt,
                  endAt: state.endAt,
                  previewFinalAt: state.previewFinalAt,
                  ...(startup ? { startup } : {}),
                  subscriptionRequests: state.subscriptionRequests,
                };
              });
              const typingReceipt = await typing.finish();
              const gatewayAfter = await gatewayProbe();
              const profileEndNs = gatewayProfile ? process.hrtime.bigint().toString() : undefined;
              await cdp.send("HeapProfiler.collectGarbage");
              const retained = await metric(cdp);
              if (startupTrace) {
                assert(!traceActive && trace.length === traceReceipt.events, "Warm trace activity");
                const serialized = JSON.stringify({ traceEvents: trace });
                await writeFile(path.join(cellDir, "startup-trace.json"), serialized);
                const interval = summarizeInteractionTrace(trace, {
                  start: "inline-startup-start",
                  end: "inline-prewarm-gc-trace-end",
                });
                const startOffsetMs = interval.startUs / 1000 - browserReceipt.startup.sendAt;
                const endOffsetMs = interval.endUs / 1000 - traceReceipt.endBrowserMs;
                traceReceipt = {
                  ...traceReceipt,
                  artifact: "startup-trace.json",
                  sha256: sha(serialized),
                  bytes: Buffer.byteLength(serialized),
                  interval,
                  startOffsetMs,
                  endOffsetMs,
                  offsetResidualMs: Math.abs(endOffsetMs - startOffsetMs),
                  traceActiveDuringWarm: traceActive,
                  warmEndEvents: trace.length,
                };
                assert(traceReceipt.offsetResidualMs <= 1, "Trace/browser clock mapping mismatch");
              }
              const websocketOverlap = typingReceipt.inputs.map((input, index) => {
                const down = typingReceipt.events.find(
                  (event) =>
                    event.checkpoint === index && event.type === "keydown" && event.capture,
                );
                return browserReceipt.frames.filter(
                  (frame) =>
                    frame.stream === "tool" &&
                    frame.phase === "update" &&
                    frame.at >= down.at &&
                    frame.at <= input.secondFrameAt,
                ).length;
              });
              const hostMinusHrLower = Math.max(
                ...clockCalibration.map((probe) => probe.beforeMs - probe.monotonicMs),
              );
              const hostMinusHrUpper = Math.min(
                ...clockCalibration.map((probe) => probe.afterMs - probe.monotonicMs),
              );
              const hostMinusBrowserLower = Math.max(
                ...typingReceipt.clockProbes.map((probe) => probe.sentAt - probe.browserAt),
              );
              const hostMinusBrowserUpper = Math.min(
                ...typingReceipt.clockProbes.map((probe) => probe.receivedAt - probe.browserAt),
              );
              assert(
                hostMinusHrLower <= hostMinusHrUpper &&
                  hostMinusBrowserLower <= hostMinusBrowserUpper,
                "clock bounds do not intersect",
              );
              const allPrewarmClockProbes = [...prewarmClockProbes, ...typingReceipt.clockProbes];
              const prewarmHostMinusBrowserBounds = {
                lowerMs: Math.max(
                  ...allPrewarmClockProbes.map((probe) => probe.sentAt - probe.browserAt),
                ),
                upperMs: Math.min(
                  ...allPrewarmClockProbes.map((probe) => probe.receivedAt - probe.browserAt),
                ),
              };
              assert(
                prewarmHostMinusBrowserBounds.lowerMs <= prewarmHostMinusBrowserBounds.upperMs,
                "startup/warm clock bounds do not intersect",
              );
              const producerOverlap = typingReceipt.inputs.map((input, index) => {
                const down = typingReceipt.events.find(
                  (event) =>
                    event.checkpoint === index && event.type === "keydown" && event.capture,
                );
                return producerReceipt.receipts.filter((receipt) => {
                  const earliest =
                    Number(receipt.beforeNs) / 1e6 + hostMinusHrLower - hostMinusBrowserUpper;
                  const latest =
                    Number(receipt.afterNs) / 1e6 + hostMinusHrUpper - hostMinusBrowserLower;
                  return earliest >= down.at && latest <= input.secondFrameAt;
                }).length;
              });
              if (renderCounters?.outputOnly) {
                const segment = renderCounters.outputOnly;
                segment.definiteNativeWrites = producerReceipt.receipts.filter((receipt) => {
                  const earliest =
                    Number(receipt.beforeNs) / 1e6 + hostMinusHrLower - hostMinusBrowserUpper;
                  const latest =
                    Number(receipt.afterNs) / 1e6 + hostMinusHrUpper - hostMinusBrowserLower;
                  return earliest >= segment.startAt && latest <= segment.endAt;
                }).length;
              }
              const sample = {
                name,
                pair,
                label: cell.label,
                inline: cell.inline,
                baseline: Boolean(cell.baseline),
                control: Boolean(cell.control),
                liveOutputExpected: cell.liveOutputExpected,
                attribution,
                calibration: false,
                setupSmoke: false,
                comparisonContractId: comparisonPlan.contractId,
                stdoutOptIn: true,
                reference: Boolean(cell.reference),
                sessionKey: key,
                commit: cell.commit,
                sourceCommit: cell.sourceCommit,
                tree: cell.tree,
                build: cell.build,
                before,
                after,
                gatewayBefore,
                gatewayAfter,
                ...(gatewayProfile
                  ? { gatewayProfile: { startNs: profileStartNs, endNs: profileEndNs } }
                  : {}),
                retained,
                renderCounters,
                latencyAttribution: null,
                producerReceipt,
                browserReceipt,
                typingDiagnostics: typingReceipt,
                clockCalibration,
                prewarm: {
                  operations: prewarmOperations,
                  clockProbes: allPrewarmClockProbes,
                  hostMinusBrowserBounds: prewarmHostMinusBrowserBounds,
                  interpretation:
                    "Host operation spans bound awaited work, not exclusive CPU ownership. Host-minus-browser offset lies within sentAt-browserAt and receivedAt-browserAt clock-probe bounds. Overlap alone is correlation, not causal attribution.",
                },
                causalDiagnostics: false,
                ...(startupTrace ? { startupTrace: traceReceipt } : {}),
                producerOverlap,
                websocketOverlap,
                resources: resources(),
                providerRequests: provider.requests,
                providerErrors: provider.errors,
                errors,
              };
              await writeFile(path.join(cellDir, "sample.json"), JSON.stringify(sample, null, 2));
              samples.push(sample);
              await json("samples.json", samples);
              // A composed draft replaces Stop with Send. Clear it outside every
              // measurement interval before asserting the still-running turn.
              await composer.fill("");
              assert(
                await stop.isVisible(),
                "turn must remain active before releasing producer-finish",
              );
              // Attribution turn only, after every measurement window. This pane
              // declined stdout throughout the writes, so a retained inline row
              // cannot make quiet-history recovery pass accidentally.
              if (workCounters && cell.label === "candidate-grouped") {
                assert.equal(await pane.locator(".chat-command-trail__preview pre").count(), 0);
                const receiptBefore = await readFile(path.join(cellDir, "producer-receipt.json"));
                await page.evaluate(() => {
                  window.inlineNativeProbe.recoveryActive = true;
                });
                const toggle = async () => {
                  await pane.locator(".chat-header-session-menu__trigger").click();
                  await page.getByRole("menuitem", { name: "View", exact: true }).click();
                  await page
                    .getByRole("menuitemcheckbox", {
                      name: "Inline command trail (this browser)",
                      exact: true,
                    })
                    .click();
                  await page.keyboard.press("Escape");
                  if (await page.locator(".chat-header-session-menu__panel:visible").count()) {
                    await page.keyboard.press("Escape");
                  }
                };
                await toggle();
                await page.waitForFunction((sessionKey) => {
                  const state = window.inlineNativeProbe;
                  const admitted = state.recoveryRequests.find(
                    (request) =>
                      request.key === sessionKey &&
                      request.method === "sessions.messages.subscribe" &&
                      request.includeLiveToolOutput &&
                      state.recoveryResponses.some(
                        (response) => response.id === request.id && response.ok,
                      ),
                  );
                  const admittedAt = state.recoveryResponses.find(
                    (response) => response.id === admitted?.id,
                  )?.at;
                  return (
                    admitted &&
                    state.recoveryResponses.some(
                      (response) =>
                        response.method === "chat.history" &&
                        response.ok &&
                        response.hasFinalMarker &&
                        response.at >= admittedAt,
                    )
                  );
                }, key);
                await pane
                  .locator(".chat-command-trail__preview pre")
                  .filter({ hasText: "output-000511:" })
                  .waitFor({ state: "visible" });
                assert(await stop.isVisible());
                assert((await pane.locator(".chat-tool-row--running").count()) > 0);
                await pane.screenshot({ path: path.join(cellDir, "quiet-recovery.png") });
                const disableAt = await page.evaluate(() => performance.now());
                await toggle();
                await page.waitForFunction(
                  ({ sessionKey, disableAt: releasedAfter }) => {
                    const state = window.inlineNativeProbe;
                    return state.recoveryRequests.some(
                      (request) =>
                        request.key === sessionKey &&
                        request.at >= releasedAfter &&
                        request.method === "sessions.messages.subscribe" &&
                        !request.includeLiveToolOutput &&
                        state.recoveryResponses.some(
                          (response) => response.id === request.id && response.ok,
                        ),
                    );
                  },
                  { sessionKey: key, disableAt },
                );
                const receiptAfter = await readFile(path.join(cellDir, "producer-receipt.json"));
                assert.deepEqual(
                  receiptAfter,
                  receiptBefore,
                  "quiet recovery cannot rely on new native writes",
                );
                sample.quietRecovery = await page.evaluate(() => {
                  const state = window.inlineNativeProbe;
                  state.recoveryActive = false;
                  return {
                    pass: true,
                    requests: state.recoveryRequests,
                    responses: state.recoveryResponses,
                    completedNativeWrites: 512,
                    finalMarkerVisibleWhileRunning: true,
                    interestReleased: true,
                  };
                });
                sample.quietRecovery.receiptSha256 = sha(receiptBefore);
              }
              if (pair === 0) {
                await pane.screenshot({ path: path.join(cellDir, "running.png") });
              }
              await writeFile(path.join(cellDir, "producer-finish"), "finish\n");
              await pane
                .getByRole("paragraph")
                .filter({ hasText: /^INLINE_NATIVE_COMMAND_COMPLETE$/u })
                .waitFor({ state: "visible" });
              // Visible final text can precede terminal persistence. This runs after
              // all timing/memory brackets and waits on the saved-history boundary.
              const historyStartedAt = performance.now();
              const historyObservations = [];
              let history;
              let savedFinal;
              for (;;) {
                history = await client.request("chat.history", {
                  sessionKey: key,
                  limit: 100,
                  maxChars: 500000,
                  toolResultMaxChars: 500000,
                  maxBytes: 2000000,
                });
                savedFinal = history.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    (typeof message.content === "string"
                      ? message.content
                      : (Array.isArray(message.content) ? message.content : [])
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("\n")) === "INLINE_NATIVE_COMMAND_COMPLETE",
                );
                historyObservations.push({
                  elapsedMs: performance.now() - historyStartedAt,
                  inFlight: Boolean(history.inFlightRun),
                  savedFinal,
                });
                if (
                  (!history.inFlightRun && savedFinal) ||
                  performance.now() - historyStartedAt >= 30000
                ) {
                  break;
                }
                await delay(100);
              }
              await writeFile(path.join(cellDir, "history.json"), JSON.stringify(history));
              await writeFile(
                path.join(cellDir, "history-completion.json"),
                JSON.stringify(historyObservations),
              );
              assert(!history.inFlightRun, "saved history must follow run completion");
              assert(savedFinal, "saved history must retain the exact final assistant reply");
              const calls = history.messages
                .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
                .filter(
                  (part) =>
                    part.type === "toolCall" &&
                    part.name === "bash" &&
                    part.arguments?.command?.includes(producer) &&
                    part.arguments.command.includes(cellDir),
                );
              assert.equal(
                calls.length,
                1,
                "one saved native command matching this producer and cell",
              );
              const toolResults = history.messages.filter(
                (message) => message.role === "toolResult" && message.toolCallId === calls[0].id,
              );
              assert.equal(toolResults.length, 1, "exactly one saved native exec result");
              assert.equal(toolResults[0].isError, false);
              const savedText = toolResults[0].content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
              // Native command transcripts retain the native receipt text;
              // structured result details are optional, unlike live tool events.
              const savedExit = savedText.match(/^Process exited with code (-?\d+)$/mu);
              assert(savedExit, "saved result must contain the native completion receipt");
              const savedExitCode = Number(savedExit[1]);
              assert.equal(savedExitCode, 0, "saved command must have exited zero");
              assert(!savedText.includes("Process running with session ID"));
              assert(
                savedText.includes("output-000000:"),
                "saved result must retain original output prefix",
              );
              sample.historyResult = {
                textBytes: Buffer.byteLength(savedText),
                sha256: sha(savedText),
                exitCode: savedExitCode,
              };
              assert.equal(provider.requests.length, 2);

              assert(
                provider.requests[1].result.truncationNotice,
                "native capture must disclose truncation of the 2 MiB workload",
              );

              assert.deepEqual(provider.errors, []);
              assert.deepEqual(errors, []);
              // Real pipe reads may coalesce writes, so assert coverage instead of one WS frame per chunk.
              assert(
                producerOverlap.filter((count) => count > 0).length >= 8,
                "fewer than eight input windows overlap definite native writes",
              );
              if (cell.liveOutputExpected) {
                assert(
                  browserReceipt.frames.some(
                    (frame) =>
                      frame.stream === "tool" && frame.phase === "update" && frame.maxIndex === 511,
                  ),
                  "candidate must deliver final live marker before command completion",
                );
              }
              if (cell.role === "candidate") {
                const marked = [
                  ...browserReceipt.startup.startupFrames,
                  ...browserReceipt.frames,
                ].filter((frame) => frame.outputOnly);
                assert(
                  cell.inline
                    ? marked.some((frame) => frame.maxIndex === 511)
                    : marked.length === 0,
                  "marked stdout must reach inline and never reach the opted-out observer",
                );
              }
              sample.status = "complete";
              await writeFile(path.join(cellDir, "sample.json"), JSON.stringify(sample, null, 2));
              await json("samples.json", samples);
              console.log(
                JSON.stringify({
                  name,
                  outputUpdates: browserReceipt.frames.filter(
                    (frame) => frame.stream === "tool" && frame.phase === "update",
                  ).length,
                  nativeOverlappingInputs: producerOverlap.filter((count) => count > 0).length,
                  websocketOverlappingInputs: websocketOverlap.filter((count) => count > 0).length,
                  longTasks: browserReceipt.tasks.length,
                }),
              );
            } catch (error) {
              await writeFile(
                path.join(cellDir, "failure.json"),
                JSON.stringify(
                  {
                    message: String(error),
                    errors,
                    providerErrors: provider.errors,
                    requests: provider.requests,
                    readiness: instance?.readiness,
                    prewarmOperations,
                    prewarmClockProbes,
                  },
                  null,
                  2,
                ),
              );
              if (page && !page.isClosed()) {
                await page.screenshot({ path: path.join(cellDir, "failure.png") }).catch(() => {});
              }
              if (instance) {
                await writeFile(path.join(cellDir, "gateway.private.log"), instance.logs());
              }
              throw error;
            }
          },
          () => writeFile(path.join(cellDir, "producer-start"), "cleanup\n"),
          () => writeFile(path.join(cellDir, "producer-finish"), "cleanup\n"),
          () => disposeTrace?.(),
          () => context?.close(),
          () => client?.stopAndWait(),
          () => instance?.cleanup(),
          () => provider.close(),
        );
      } finally {
        await writeFile(
          path.join(cellDir, "lifecycle-resources.json"),
          JSON.stringify(
            {
              comparisonContractId: comparisonPlan.contractId,
              before: lifecycleBefore,
              after: resources(),
              interpretation:
                "Enclosing cgroup covers startup, active work, completion and attempted cleanup, including exited descendants, benchmark work and background services. It is not product-only CPU and must not be added to overlapping process totals. A thrown fixture still retains its failure; this receipt does not certify settlement.",
            },
            null,
            2,
          ),
        );
      }
    }
  }
  await json("completion.json", {
    status: "complete",
    cells: samples.length,
    finalResources: resources(),
  });
} finally {
  await json("resource-final.json", { initial: afterIdle, final: resources() });
  try {
    await browserCdp?.detach();
  } finally {
    await browser.close();
  }
}
