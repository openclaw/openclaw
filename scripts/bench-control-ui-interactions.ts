import { execFileSync, spawn } from "node:child_process";
// Production-renderer warm interactions. Trace once for attribution; compare untraced AB pairs.
// --thread-cpu-time excludes renderer descheduling from duration metrics.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type CDPSession, type Page } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import type { ProjectionFixtureFacts } from "../ui/src/test-helpers/control-ui-projection-fixture-contract.ts";
import { createControlUiSandboxFixtureServer } from "../ui/src/test-helpers/control-ui-sandbox-fixture-server.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { mapColdLoadCpuProfile, summarizeCpuProfile } from "./lib/control-ui-cold-load-trace.ts";
import {
  createScenarioFixture,
  interactionScenarios,
  installInteractionNavigationPreloadObserver,
  settleInteractionNavigationPreloads,
  settleSidebarBackgroundWork,
  type InteractionNavigationPreloads,
  type InteractionEvidence,
  type InteractionSandbox,
} from "./lib/control-ui-interaction-scenarios.ts";
import {
  clipInteractionCpuProfile,
  summarizeInteractionSelectors,
  summarizeInteractionTrace,
  summarizeLongTaskCpuProfiles,
  type InteractionStyleSheet,
} from "./lib/control-ui-interaction-trace.ts";
import { launchControlUiObservationBrowser } from "./lib/control-ui-observation-browser.ts";
import {
  createProjectionBoardResponses,
  disposeProjectionFixture,
  finishProjectionFixture,
  prepareProjectionFixture,
} from "./lib/control-ui-projection-fixtures.ts";
import {
  installControlUiResourceCounts,
  readControlUiResourceCounts,
  type ControlUiResourceCounts,
} from "./lib/control-ui-resource-counts.ts";
import {
  createWorkboardResourceFixture,
  prepareWorkboardResourceSource,
} from "./lib/control-ui-workboard-resource-fixture.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    "control-bundle-dir": { type: "string" },
    "workboard-source-root": { type: "string" },
    "compare-workboard-source-root": { type: "string" },
    "control-workboard-source-root": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-interactions" },
    steps: { type: "string" },
    viewport: { type: "string", default: "both" },
    pairs: { type: "string", default: "1" },
    "cpu-throttle": { type: "string", default: "1" },
    trace: { type: "boolean", default: false },
    "selector-stats": { type: "boolean", default: false },
    theme: { type: "string", default: "light" },
    "thread-cpu-time": { type: "boolean", default: false },
    "function-counts": { type: "boolean", default: false },
    "graph-counts": { type: "boolean", default: false },
    "first-pair-screenshots": { type: "boolean", default: false },
    "invalidation-tracking": { type: "boolean", default: false },
    "resource-counts": { type: "boolean", default: false },
    "process-wakeups": { type: "boolean", default: false },
    "renderer-process-metrics": { type: "boolean", default: false },
    counterbalance: { type: "boolean", default: false },
    "asset-latency-ms": { type: "string", default: "0" },
    "projection-fixtures": { type: "boolean", default: false },
    "projection-counts": { type: "boolean", default: false },
    "data-pages": { type: "boolean", default: false },
    "retained-heap": { type: "boolean", default: false },
  },
});
const trace = values.trace || values["selector-stats"];
if (values["graph-counts"] && (trace || values["function-counts"] || values["projection-counts"])) {
  throw new Error("Run reactive graph counts separately from CPU/coverage instrumentation");
}
if (values["projection-counts"] && !values["projection-fixtures"]) {
  throw new Error("--projection-counts requires --projection-fixtures");
}
if (values["projection-counts"] && trace) {
  throw new Error("Run precise projection counts separately from CPU profiles/traces");
}
if (values["function-counts"] && trace) {
  throw new Error("Run precise function counts separately from CPU profiles/traces");
}
if (values["projection-fixtures"] && values["resource-counts"]) {
  throw new Error("Run native resource counts separately from projection fixture measurements");
}
if (values.theme !== "light" && values.theme !== "dark") {
  throw new Error("theme must be light or dark");
}
const theme = values.theme;
const pairs = Number(values.pairs);
const cpuThrottle = Number(values["cpu-throttle"]);
const assetLatencyMs = Number(values["asset-latency-ms"]);
if (!Number.isFinite(assetLatencyMs) || assetLatencyMs < 0) {
  throw new Error("asset-latency-ms must be nonnegative");
}
if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
  throw new Error("cpu-throttle must be at least 1");
}
if (!Number.isInteger(pairs) || pairs < 1) {
  throw new Error("pairs must be a positive integer");
}
if (values["control-bundle-dir"] && !values["compare-bundle-dir"]) {
  throw new Error(
    "control-bundle-dir requires compare-bundle-dir for baseline/candidate/control order",
  );
}
if (!["desktop", "mobile", "both"].includes(values.viewport)) {
  throw new Error("viewport must be desktop, mobile or both");
}
const selectedIds = values.steps?.split(",");
const scenarios = interactionScenarios.filter((step) => {
  if (Boolean(step.projectionFamily) !== values["projection-fixtures"]) {
    return false;
  }
  if (!selectedIds && Boolean(step.dataPage) !== values["data-pages"]) {
    return false;
  }
  return selectedIds
    ? selectedIds.includes(step.id)
    : !step.explicitOnly && (!step.resourceOnly || values["resource-counts"]);
});
if (!scenarios.length || selectedIds?.some((id) => !scenarios.some((step) => step.id === id))) {
  throw new Error("Unknown or empty interaction steps");
}
const artifactDir = createControlUiE2eArtifactDir("warm", values.output);
const bundles = [
  values["bundle-dir"],
  values["compare-bundle-dir"],
  values["control-bundle-dir"],
].filter((directory): directory is string => Boolean(directory));
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
].filter((viewport) => values.viewport === "both" || values.viewport === viewport.name);

async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function metrics(
  cdp: CDPSession,
): Promise<Record<string, number> & { JSHeapUsedSize: number }> {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  const measured = Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  const heapUsed = measured.JSHeapUsedSize;
  if (heapUsed === undefined) {
    throw new Error("Chromium did not report the required JS heap metric");
  }
  return { ...measured, JSHeapUsedSize: heapUsed };
}

type RendererProcessSnapshot = Array<{ id: number; cpuSeconds: number; rssBytes: number }>;

async function rendererProcesses(cdp: CDPSession): Promise<RendererProcessSnapshot> {
  const { processInfo }: { processInfo: Array<{ id: number; type: string; cpuTime: number }> } =
    await cdp.send("SystemInfo.getProcessInfo");
  const renderers = processInfo.filter(({ type }) => type === "renderer");
  if (
    !renderers.length ||
    renderers.some(
      ({ id, cpuTime }) => !Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(cpuTime),
    )
  ) {
    throw new Error("The owned browser did not provide valid renderer processes");
  }
  // Only CDP-reported PIDs from this benchmark-owned browser reach ps.
  const rows = execFileSync(
    "/bin/ps",
    ["-o", "pid=,rss=", "-p", renderers.map(({ id }) => id).join(",")],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  )
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  return renderers.map(({ id, cpuTime }) => {
    const rss = rows.find(([pid]) => pid === id)?.[1];
    if (rss === undefined || !Number.isFinite(rss) || rss < 0) {
      throw new Error(`Renderer ${id} did not supply a valid RSS snapshot`);
    }
    return { id, cpuSeconds: cpuTime, rssBytes: rss * 1024 };
  });
}

function distribution(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}

type ProcessWakeupSample = {
  sampleStartMach: string;
  sampleEndMach: string;
  timebase: { numer: number; denom: number };
  processes: Array<{
    pid: number;
    ppid?: number;
    uid?: number;
    startAbstime?: string;
    exitAbstime?: string;
    interruptWakeups?: string;
    packageIdleWakeups?: string;
    error?: string;
    errno?: number;
  }>;
};
type ProcessWakeupSnapshot = {
  // CDP supplies cumulative whole-process CPU seconds; rusage CPU units are not assumed.
  cdpProcesses: Array<{ id: number; type: string; cumulativeCpuSeconds: number }>;
  rusage: ProcessWakeupSample;
};
type ProcessWakeups = {
  complete: boolean;
  nativeBrowserPid?: number;
  reason?: string;
  before?: ProcessWakeupSnapshot;
  after?: ProcessWakeupSnapshot;
  delta?: { interruptWakeups: string; packageIdleWakeups: string };
};

async function readProcessWakeups(
  session: CDPSession,
  reader: string,
  expectedBrowserPid?: number,
): Promise<ProcessWakeupSnapshot> {
  const { processInfo }: { processInfo: Array<{ id: number; type: string; cpuTime: number }> } =
    await session.send("SystemInfo.getProcessInfo");
  const browserPids = processInfo.filter((process) => process.type === "browser");
  const ids = processInfo.map((process) => process.id);
  if (
    browserPids.length !== 1 ||
    (expectedBrowserPid !== undefined && browserPids[0]!.id !== expectedBrowserPid) ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("The active owned browser did not supply one valid process set");
  }
  // No process discovery: only this owned browser's explicit OS PIDs reach libproc.
  const rusage: ProcessWakeupSample = JSON.parse(
    execFileSync(reader, ids.map(String), { encoding: "utf8", timeout: 10_000 }),
  );
  return {
    cdpProcesses: processInfo.map(({ id, type, cpuTime }) => ({
      id,
      type,
      cumulativeCpuSeconds: cpuTime,
    })),
    rusage,
  };
}

function finishProcessWakeups(observation: ProcessWakeups): void {
  const { before, after } = observation;
  if (!before || !after) {
    throw new Error("Both process snapshots are required");
  }
  const processSet = (snapshot: ProcessWakeupSnapshot) =>
    snapshot.cdpProcesses
      .map(({ id, type }) => `${id}:${type}`)
      .toSorted()
      .join(",");
  if (processSet(before) !== processSet(after)) {
    throw new Error("Owned Chromium processes changed between snapshots");
  }
  let interruptWakeups = 0n;
  let packageIdleWakeups = 0n;
  for (const snapshot of [before, after]) {
    const rows = snapshot.rusage.processes;
    if (
      rows.length !== snapshot.cdpProcesses.length ||
      new Set(rows.map(({ pid }) => pid)).size !== rows.length ||
      rows.some((row) => row.error || !snapshot.cdpProcesses.some(({ id }) => id === row.pid))
    ) {
      throw new Error("Incomplete Darwin rusage process set");
    }
  }
  for (const initial of before.rusage.processes) {
    const final = after.rusage.processes.find(({ pid }) => pid === initial.pid)!;
    if (
      !initial.startAbstime ||
      initial.startAbstime === "0" ||
      initial.startAbstime !== final.startAbstime ||
      initial.uid !== final.uid ||
      initial.ppid !== final.ppid ||
      initial.exitAbstime !== "0" ||
      final.exitAbstime !== "0"
    ) {
      throw new Error(`Process ${initial.pid} changed identity or exited`);
    }
    const interrupts = BigInt(final.interruptWakeups!) - BigInt(initial.interruptWakeups!);
    const packageIdle = BigInt(final.packageIdleWakeups!) - BigInt(initial.packageIdleWakeups!);
    if (interrupts < 0n || packageIdle < 0n) {
      throw new Error(`Process ${initial.pid} counters moved backwards`);
    }
    interruptWakeups += interrupts;
    packageIdleWakeups += packageIdle;
  }
  observation.delta = {
    interruptWakeups: String(interruptWakeups),
    packageIdleWakeups: String(packageIdleWakeups),
  };
  observation.complete = true;
  delete observation.reason;
}

type Result = {
  step: string;
  viewport: string;
  bundle: number;
  pair: number;
  status: "passed" | "failed" | "skipped";
  hostLoadAverage: number[];
  wallMs?: number;
  scriptMs?: number;
  taskMs?: number;
  layoutMs?: number;
  styleMs?: number;
  heapBeforeBytes?: number;
  heapAfterBytes?: number;
  heapDeltaBytes?: number;
  rendererCpuMs?: number;
  rendererRssBeforeBytes?: number;
  rendererRssAfterBytes?: number;
  rendererProcessMetrics?: {
    before?: RendererProcessSnapshot;
    after?: RendererProcessSnapshot;
    complete: boolean;
    error?: string;
  };
  durationBreakdownMs?: Record<string, number>;
  retainedHeap?: { beforeBytes: number; afterBytes?: number; deltaBytes?: number };
  longTasks?: { count: number; totalMs: number; maxMs: number };
  requests?: Record<string, number>;
  scenarioEvidence?: InteractionEvidence;
  domBefore?: { nodes: number; menuItems: number; namedAnchors: number };
  domAfter?: { nodes: number; menuItems: number; namedAnchors: number };
  rowIdentity?: { initial: number; created: number; retained: number; final: number };
  navigationPreloads?: InteractionNavigationPreloads;
  resourcesBefore?: ControlUiResourceCounts;
  resourcesAfter?: ControlUiResourceCounts;
  processWakeups?: ProcessWakeups;
  projectionFixture?: ProjectionFixtureFacts;
  projectionCoverageArtifact?: string;
  functionCoverageArtifact?: string;
  functionCoveragePreparationArtifact?: string;
  reactiveGraphArtifact?: string;
  projectionScreenshotArtifact?: string;
  measurementClass?:
    | "production-interaction"
    | "projection-counter"
    | "projection-cpu"
    | "diagnostic";
  skipReason?: string;
  trace?: ReturnType<typeof summarizeInteractionTrace>;
  longTaskDetails?: ReturnType<typeof summarizeLongTaskCpuProfiles>;
  selectorStats?: { artifact: string; stylePasses: number; selectorCount: number };
  error?: string;
  artifactPrefix: string;
};
const results: Result[] = [];
const pairHostObservations: Array<{
  step: string;
  viewport: string;
  pair: number;
  startedAt: string;
  startLoad: number[];
  endedAt: string;
  endLoad: number[];
}> = [];
const servers: Array<{
  directory: string;
  build: { buildId: string; version: string };
  indexSha256: string;
  workboardSource?: Awaited<ReturnType<typeof prepareWorkboardResourceSource>>;
  projectionBuild?: { entry: string; descriptorSha256: string; entrySha256: string };
  server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
}> = [];
let processWakeupReader: string | undefined;
let processWakeupSetupError: string | undefined;
let processWakeupBuild: { command: string; argv: string[]; sourceSha256: string } | undefined;
if (values["process-wakeups"]) {
  if (process.platform !== "darwin") {
    processWakeupSetupError = "Darwin proc_pid_rusage is unavailable on this platform";
  } else {
    try {
      const source = fileURLToPath(new URL("./perf/darwin-process-wakeups.c", import.meta.url));
      const executable = path.join(artifactDir, "darwin-process-wakeups");
      const argv = ["clang", "-O2", "-Wall", "-Wextra", "-std=c11", source, "-o", executable];
      processWakeupBuild = {
        command: "/usr/bin/xcrun",
        argv,
        sourceSha256: createHash("sha256")
          .update(await readFile(source))
          .digest("hex"),
      };
      // Build once before launching Chromium, never during an observation.
      execFileSync(processWakeupBuild.command, argv, { timeout: 30_000, stdio: "pipe" });
      processWakeupReader = executable;
    } catch (error) {
      processWakeupSetupError = String(error);
    }
  }
}
const browserExecutable = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browser = await chromium.launch({
  executablePath: browserExecutable,
});

async function launchNativeVisibilityContext() {
  const profile = await mkdtemp(path.join(artifactDir, "native-chromium-"));
  const child = spawn(
    resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      // Full Chrome headless still hides a natively minimized window; the headless shell does not.
      "--headless=new",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let terminationRequested = false;
  let nativeBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const close = async () => {
    try {
      await nativeBrowser?.close();
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        terminationRequested = child.kill("SIGTERM");
        await stopped;
      }
      await rm(profile, { recursive: true, force: true });
    }
    if (child.pid !== undefined) {
      const exit = await stopped;
      await writeFile(
        path.join(artifactDir, `native-browser-${child.pid}.process.json`),
        JSON.stringify({ pid: child.pid, ...exit, terminationRequested }, null, 2),
      );
      if (
        !(exit.code === 0 && exit.signal === null) &&
        !(terminationRequested && exit.signal === "SIGTERM")
      ) {
        throw new Error(`Native visibility Chromium exited with ${exit.code}/${exit.signal}`);
      }
    }
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Native Chromium did not start")), 30_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Native Chromium exited before connection"));
      });
      const readEndpoint = (data: Buffer) => {
        output += data.toString();
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (match) {
          clearTimeout(timeout);
          child.stderr.off("data", readEndpoint);
          child.stderr.resume();
          resolve(match[1]!);
        }
      };
      child.stderr.on("data", readEndpoint);
    });
    // Playwright's normal contexts force focus/visibility even after minimization.
    // Only this runner-owned fresh profile uses native browser visibility.
    nativeBrowser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = nativeBrowser.contexts()[0];
    if (!context) {
      throw new Error("Native Chromium did not expose its default context");
    }
    return { context, close, processId: child.pid };
  } catch (error) {
    await close();
    throw error;
  }
}

class ScenarioSkipped extends Error {}
let sandboxServer: ReturnType<typeof createControlUiSandboxFixtureServer> | undefined;
let sandbox: InteractionSandbox | undefined;
try {
  if (
    scenarios.some(
      ({ fixture }) =>
        fixture?.boardFrameResources || fixture?.canvasFrameRetention || fixture?.mcpAppResources,
    )
  ) {
    sandboxServer = createControlUiSandboxFixtureServer();
    await new Promise<void>((resolve, reject) => {
      sandboxServer!.once("error", reject);
      sandboxServer!.listen(0, "127.0.0.1", resolve);
    });
    const address = sandboxServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Interaction sandbox did not bind a TCP port");
    }
    sandbox = {
      sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
      sandboxPort: address.port,
    };
  }
  for (const [bundleIndex, directory] of bundles.entries()) {
    const resolved = path.resolve(directory);
    const html = await readFile(path.join(resolved, "index.html"), "utf8");
    const raw = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!raw) {
      throw new Error(`Missing build identity: ${directory}`);
    }
    const build: { buildId: string; version: string } = JSON.parse(raw);
    const sourceRoot = [
      values["workboard-source-root"],
      values["compare-workboard-source-root"],
      values["control-workboard-source-root"],
    ][bundleIndex];
    const needsWorkboard = scenarios.some((scenario) => scenario.fixture?.workboardResources);
    if (needsWorkboard && !sourceRoot) {
      throw new Error(`Missing explicit Workboard source root for bundle ${bundleIndex}`);
    }
    const workboardSource =
      needsWorkboard && sourceRoot ? await prepareWorkboardResourceSource(sourceRoot) : undefined;
    let projectionBuild: (typeof servers)[number]["projectionBuild"];
    if (values["projection-fixtures"]) {
      const descriptor = await readFile(path.join(resolved, "projection-fixture.json"), "utf8");
      const parsed: unknown = JSON.parse(descriptor);
      if (
        !isRecord(parsed) ||
        parsed.benchmarkOnly !== true ||
        typeof parsed.entry !== "string" ||
        !parsed.entry.startsWith("assets/")
      ) {
        throw new Error(`Missing benchmark-only projection build: ${directory}`);
      }
      const entry = await readFile(path.join(resolved, parsed.entry));
      projectionBuild = {
        entry: parsed.entry,
        descriptorSha256: createHash("sha256").update(descriptor).digest("hex"),
        entrySha256: createHash("sha256").update(entry).digest("hex"),
      };
    }
    servers.push({
      directory: resolved,
      workboardSource,
      build,
      indexSha256: createHash("sha256").update(html).digest("hex"),
      projectionBuild,
      server: await startControlUiBenchGatewayServer(resolved, 0, assetLatencyMs),
    });
  }
  await writeFile(
    path.join(artifactDir, "manifest.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        browser: browser.version(),
        browserExecutable,
        host: {
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          load: os.loadavg(),
        },
        collection: trace
          ? "CDP trace + 1ms CPU profiler (overhead included)"
          : "untraced CDP metrics",
        metricTimeDomain: values["thread-cpu-time"] ? "threadTicks" : "timeTicks",
        functionCounts: values["function-counts"]
          ? "Precise coverage starts before navigation and resets after preparation; diagnostic overhead, not timing evidence."
          : false,
        reactiveGraphCounts: values["graph-counts"]
          ? "Observe-only Solid build; diagnostic counts, not production timing evidence."
          : false,
        cpuThrottle,
        retainedHeap: values["retained-heap"]
          ? "Separate GC-controlled proof: collect before tracing and after action metrics/tracing; not a timing comparison."
          : false,
        pairOrder: values["control-bundle-dir"]
          ? values.counterbalance
            ? "ABC/CBA alternating by pair"
            : "ABC"
          : values.counterbalance
            ? "AB/BA alternating by pair"
            : "AB",
        assetLatency: {
          milliseconds: assetLatencyMs,
          scope:
            "Simulated asset RTT: response delay for every owned HTTP-server request, including worker modules; no bandwidth shaping or Gateway/provider delay.",
        },
        rendererProcessMetrics: values["renderer-process-metrics"]
          ? "CDP whole-renderer-process CPU (including dedicated workers), plus ps RSS endpoint snapshots; not retained heap or GPU memory."
          : false,
        heavyContentWorkerObservation: scenarios.some(({ id }) => id.startsWith("heavy-"))
          ? "Benchmark init script observes only markdown-code-highlight Worker starts, replies, errors, termination and live count."
          : false,
        mobileTouchEmulation: true,
        screenshots: values["first-pair-screenshots"] ? "first pair per cell" : "all",
        resourceCounts: values["resource-counts"]
          ? "Instrumented top-frame native registrations, including fixture resources; measure timings separately without this flag."
          : false,
        processWakeups: values["process-wakeups"]
          ? {
              collector: "Darwin proc_pid_rusage RUSAGE_INFO_V0",
              scope: "CDP-reported process set of the active owned Chromium browser",
              supported: Boolean(processWakeupReader),
              setupError: processWakeupSetupError,
              build: processWakeupBuild,
              limitations: [
                "Interrupt-level wakeups and package-idle subset, not every OS wakeup",
                "Two sequential endpoint snapshots include control-message and read skew",
                "Transient processes entirely between endpoints are not observed",
                "CDP CPU values are cumulative seconds; Chromium may substitute zero on read failure",
              ],
            }
          : false,
        preferences: { lobsterPetVisits: false },
        invalidationTracking:
          trace && (values["invalidation-tracking"] || values["selector-stats"]),
        selectorStats: values["selector-stats"],
        theme,
        fixture: { sessions: 1000, messagesPerSession: 400, models: 1000, cronJobs: 500 },
        projectionBenchmark: values["projection-fixtures"]
          ? {
              instrumented: values["projection-counts"],
              shippingBundleProof: false,
              mountedPerFamily: {
                "agent-rows": { A: 400, B: 80 },
                outbox: { A: 400, B: 80 },
                "board-pins": { A: 400, B: 80 },
                "sdk-avatars": { A: 120, B: 40 },
                "sdk-avatar-identities": { A: 120, B: 40 },
                tooltips: { A: 100 },
                "link-providers": { A: 100, B: 30 },
                "link-metadata": { A: 100, B: 30 },
                "ci-pairs": { A: 100, B: 30 },
                "clawhub-cards": { A: 100, B: 30 },
              },
              publications: 20,
              nativeResourceWork: {
                tooltips: "20 native child-list mutation batches",
                "link-providers": "20 native child-list mutation batches in A",
                "link-metadata": "20 replay request events; two actual panel producers",
                "ci-pairs": "20 native A Gateway snapshots",
                "clawhub-cards": "20 native A Gateway snapshots",
                idle: "No deliberate publication; three native-clock seconds",
              },
              note: "Extra benchmark-only entry changes the build graph; compare identical entry builds and measure shipping bytes separately.",
            }
          : undefined,
        acceptance:
          "For fixed steps: >=10 serial AB pairs per viewport, all median/p95/min/max cells reviewed; any >20% regression stops landing. Compare startup with its same-host merge base; growth beyond build variance needs an accepted measured win.",
        exclusions: [
          "No live Gateway/provider",
          "No sidebar text input exists; measure command palette search separately",
          "No fake clocks or Lit probes; optional asset delay is recorded above and other simulated transport delays are named by their scenario",
        ],
        scenarios: scenarios.map(
          ({ id, route, expected, fixture, dataPage, diagnostic, observationBrowser }) => ({
            id,
            route,
            expected,
            fixture,
            dataPage,
            diagnostic,
            observationBrowser,
          }),
        ),
        viewports,
        bundles: servers.map(
          ({ directory, build, indexSha256, workboardSource, projectionBuild }, index) => ({
            role: index === 0 ? "baseline" : index === 1 ? "candidate" : "control",
            directory,
            ...build,
            indexSha256,
            workboardSource,
            projectionBuild,
          }),
        ),
      },
      null,
      2,
    ),
  );
  for (const viewport of viewports) {
    for (const scenario of scenarios) {
      for (let pair = 0; pair < pairs; pair++) {
        const startedAt = new Date().toISOString();
        const startLoad = os.loadavg();
        const slots = [...servers.entries()];
        if (values.counterbalance && pair % 2 === 1) {
          slots.reverse();
        }
        for (const [bundle, slot] of slots) {
          const artifactPrefix = `${viewport.name}-${theme}-${scenario.id}-${pair + 1}-${bundle}`;
          const nativeVisibility =
            scenario.visibility === "hidden" ? await launchNativeVisibilityContext() : undefined;
          const observationBrowser =
            scenario.observationBrowser && !nativeVisibility
              ? await launchControlUiObservationBrowser({
                  viewport: { width: viewport.width, height: viewport.height },
                  artifactDir,
                  artifactPrefix,
                  colorScheme: theme,
                  isMobile: viewport.name === "mobile",
                  hasTouch: viewport.name === "mobile",
                })
              : undefined;
          const ownedBrowserPid = nativeVisibility?.processId ?? observationBrowser?.processId;
          const context =
            nativeVisibility?.context ??
            observationBrowser?.context ??
            (await browser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              isMobile: viewport.name === "mobile",
              hasTouch: viewport.name === "mobile",
              serviceWorkers: "block",
              colorScheme: theme,
            }));
          let page: Page;
          try {
            if (
              scenario.fixture?.boardFrameResources ||
              scenario.fixture?.canvasFrameRetention ||
              scenario.fixture?.mcpAppResources
            ) {
              await context.grantPermissions(["local-network-access"]);
            }
            page = await context.newPage();
            if (nativeVisibility) {
              await page.setViewportSize({ width: viewport.width, height: viewport.height });
              await page.emulateMedia({ colorScheme: theme });
              await page.bringToFront();
            }
            page.setDefaultTimeout(15_000 * cpuThrottle);
            // tsx preserves names in serialized fixture callbacks, as in the cold-load runner.
            await page.addInitScript("globalThis.__name = (fn) => fn");
            await page.addInitScript(() => performance.setResourceTimingBufferSize(2048));
            await page.addInitScript(installInteractionNavigationPreloadObserver);
            // Random per-load pets can repaint continuously; measure the selected interaction.
            await page.addInitScript(
              ({ key, gatewayUrl }) => {
                if (window !== window.top) {
                  return;
                }
                localStorage.setItem(key, JSON.stringify({ gatewayUrl, lobsterPetVisits: false }));
              },
              {
                key: controlUiBundledSettingsStorageKey(slot.server.baseUrl),
                gatewayUrl: controlUiBundledGatewayUrl(slot.server.baseUrl),
              },
            );
            if (values["resource-counts"]) {
              await page.addInitScript(installControlUiResourceCounts);
            }
          } catch (error) {
            await nativeVisibility?.close();
            await observationBrowser?.close();
            throw error;
          }
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const result: Result = {
            step: scenario.id,
            viewport: viewport.name,
            pair,
            bundle,
            status: "failed",
            hostLoadAverage: os.loadavg(),
            artifactPrefix,
            ...(values["process-wakeups"]
              ? {
                  processWakeups: {
                    complete: false,
                    nativeBrowserPid: ownedBrowserPid,
                    reason: processWakeupSetupError ?? "Sampling not reached",
                  },
                }
              : {}),
          };
          let cdp: CDPSession | undefined;
          let processSession: CDPSession | undefined;
          let tracing = false;
          let profiling = false;
          let preciseCoverage = false;
          let minimizedWindow: number | undefined;
          const events: unknown[] = [];
          const styleSheets = new Map<string, InteractionStyleSheet>();
          try {
            cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
            if (values["function-counts"]) {
              // Starting after warmup can miss calls in already optimized functions.
              await cdp.send("Profiler.enable");
              await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
              preciseCoverage = true;
            }
            if (
              nativeVisibility &&
              (scenario.fixture?.boardFrameResources ||
                scenario.fixture?.browserResources ||
                scenario.fixture?.workboardResources)
            ) {
              // Native default contexts allow service workers, which hide fixture fetches from page.route.
              await cdp.send("Network.enable");
              await cdp.send("Network.setBypassServiceWorker", { bypass: true });
            }
            const workboardSource = scenario.fixture?.workboardResources
              ? slot.workboardSource
              : undefined;
            const fixture = workboardSource
              ? createWorkboardResourceFixture(
                  slot.build.buildId,
                  slot.build.version,
                  workboardSource.root,
                )
              : createScenarioFixture(slot.build.buildId, slot.build.version, scenario, sandbox);
            const sessions = createTeamScaleSidebarListOwner({
              rows: fixture.sessions,
              viewerProfileId: "interaction-viewer",
              now: 1_800_000_000_000,
              defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
              owners: [],
            });
            const boardResponse = createProjectionBoardResponses();
            const defaultRequestHandlers: Record<string, (params: unknown) => unknown> = {
              ...(scenario.projectionFamily
                ? {
                    "board.get": (params: unknown) => {
                      if (!isRecord(params)) {
                        throw new Error("Expected board.get parameters");
                      }
                      return boardResponse(params);
                    },
                  }
                : {}),
              "sessions.list": (params: unknown) => {
                if (!isRecord(params)) {
                  throw new Error("Expected sessions.list query parameters");
                }
                return sessions.list(params).result;
              },
            };
            // Keep the same readiness contract with a timeout scaled for intentional throttling.
            const gateway = await installMockGateway(
              page,
              { ...fixture, awaitInitialRoster: false },
              {
                requestHandlers: {
                  ...defaultRequestHandlers,
                  ...scenario.createRequestHandlers?.(defaultRequestHandlers),
                },
              },
            );
            await scenario.setup?.(page);
            await page.goto(new URL(scenario.route, slot.server.baseUrl).href);
            await waitForControlUiInitialRoster(page, 15_000 * cpuThrottle);
            await scenario.prepare(page, gateway);
            if (
              nativeVisibility &&
              (scenario.fixture?.boardFrameResources ||
                scenario.fixture?.browserResources ||
                scenario.fixture?.workboardResources)
            ) {
              await cdp.send("Network.setBypassServiceWorker", { bypass: false });
              await cdp.send("Network.disable");
            }
            result.measurementClass =
              scenario.diagnostic || values["function-counts"] || values["graph-counts"]
                ? "diagnostic"
                : scenario.projectionFamily
                  ? values["projection-counts"]
                    ? "projection-counter"
                    : "projection-cpu"
                  : "production-interaction";
            if (scenario.projectionFamily) {
              result.projectionFixture = await prepareProjectionFixture(
                page,
                scenario.projectionFamily,
                values["projection-counts"],
              );
              // Native instance fixtures have no shell or navigation prefetch owner.
              if (scenario.route !== "/instance-resource-fixture.html") {
                await page.waitForFunction(() => window.openclawControlUi !== undefined);
                await settleSidebarBackgroundWork(page);
              }
            }
            if (scenario.route !== "/instance-resource-fixture.html") {
              result.navigationPreloads = await settleInteractionNavigationPreloads(page);
            }
            // Slow CPUs can still be loading boot modules after the first ready frame.
            await page.waitForLoadState("networkidle");
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await settle(page);
            const activePet = await page.evaluate(
              () => document.querySelector("openclaw-lobster-pet .lobster-pet__body") !== null,
            );
            if (activePet) {
              throw new Error("Warm interaction fixture must disable unrelated pet visits");
            }
            await page.locator(`html[data-theme-mode="${theme}"]`).waitFor({ state: "attached" });
            await cdp.send("Performance.enable", {
              timeDomain: values["thread-cpu-time"] ? "threadTicks" : "timeTicks",
            });
            if (values["retained-heap"]) {
              await cdp.send("HeapProfiler.collectGarbage");
              const initial = await metrics(cdp);
              if (initial.JSHeapUsedSize === undefined) {
                throw new Error("Missing JSHeapUsedSize after initial garbage collection");
              }
              result.retainedHeap = { beforeBytes: initial.JSHeapUsedSize };
            }
            if (values["selector-stats"]) {
              cdp.on(
                "CSS.styleSheetAdded",
                ({ header }: { header: InteractionStyleSheet & { styleSheetId: string } }) =>
                  styleSheets.set(header.styleSheetId, {
                    sourceURL: header.sourceURL,
                    origin: header.origin,
                    title: header.title,
                    startLine: header.startLine,
                    startColumn: header.startColumn,
                  }),
              );
              await cdp.send("DOM.enable");
              await cdp.send("CSS.enable");
            }
            if (trace) {
              cdp.on("Tracing.dataCollected", ({ value }: { value: unknown[] }) =>
                events.push(...value),
              );
              await cdp.send("Tracing.start", {
                categories: [
                  "toplevel,blink.user_timing,devtools.timeline",
                  ...(values["invalidation-tracking"] || values["selector-stats"]
                    ? ["disabled-by-default-devtools.timeline.invalidationTracking"]
                    : []),
                  ...(values["selector-stats"]
                    ? [
                        "disabled-by-default-devtools.timeline.css",
                        "disabled-by-default-blink.debug",
                      ]
                    : []),
                ].join(","),
                transferMode: "ReportEvents",
              });
              tracing = true;
              await cdp.send("Profiler.enable");
              await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
              await cdp.send("Profiler.start");
              profiling = true;
            }
            if (scenario.visibility === "hidden") {
              const { windowId } = await cdp.send("Browser.getWindowForTarget");
              minimizedWindow = windowId;
              await cdp.send("Browser.setWindowBounds", {
                windowId,
                bounds: { windowState: "minimized" },
              });
              // Never simulate hidden: an unhidden or frozen renderer would make this idle measurement meaningless.
              const hidden = await page
                .waitForFunction(() => document.visibilityState === "hidden", undefined, {
                  timeout: 1_000,
                  polling: 50,
                })
                .then(
                  () => true,
                  () => false,
                );
              if (!hidden) {
                throw new ScenarioSkipped(
                  "Native window minimization did not hide the page; this Chromium build cannot produce hidden-idle proof.",
                );
              }
            }
            if (values["resource-counts"]) {
              result.resourcesBefore = await readControlUiResourceCounts(page);
            }
            const requestsBefore = (await gateway.getRequests()).length;
            const countDom = () =>
              page.evaluate(() => ({
                nodes: document.querySelectorAll("*").length,
                menuItems: document.querySelectorAll('[role^="menuitem"]').length,
                namedAnchors: [...document.querySelectorAll<HTMLElement>("[style]")].filter(
                  (element) => element.style.getPropertyValue("anchor-name"),
                ).length,
              }));
            result.domBefore = await countDom();
            const rowProbe = scenario.rowSelector
              ? await page.evaluateHandle((selector) => {
                  const original = [...document.querySelectorAll(selector)];
                  const seen = new WeakSet(original);
                  const state = { original, created: 0 };
                  const observer = new MutationObserver((records) => {
                    for (const record of records) {
                      for (const node of record.addedNodes) {
                        if (!(node instanceof Element)) {
                          continue;
                        }
                        const rows = [...node.querySelectorAll(selector)];
                        if (node.matches(selector)) {
                          rows.push(node);
                        }
                        for (const row of rows) {
                          if (!seen.has(row)) {
                            seen.add(row);
                            state.created++;
                          }
                        }
                      }
                    }
                  });
                  observer.observe(document.body, { childList: true, subtree: true });
                  return { state, observer };
                }, scenario.rowSelector)
              : undefined;
            if (values["process-wakeups"]) {
              const observation = result.processWakeups!;
              observation.reason = processWakeupSetupError ?? "Process observation did not finish";
              if (processWakeupReader) {
                try {
                  if ((nativeVisibility || observationBrowser) && ownedBrowserPid === undefined) {
                    throw new Error("Native owned Chromium launch did not retain its PID");
                  }
                  const ownedBrowser = context.browser();
                  if (!ownedBrowser) {
                    throw new Error("Active context has no owned Chromium browser");
                  }
                  processSession = await ownedBrowser.newBrowserCDPSession();
                  observation.before = await readProcessWakeups(
                    processSession,
                    processWakeupReader,
                    ownedBrowserPid,
                  );
                } catch (error) {
                  observation.reason = String(error);
                }
              }
            }
            if (values["renderer-process-metrics"]) {
              const observation: NonNullable<Result["rendererProcessMetrics"]> = {
                complete: false,
              };
              result.rendererProcessMetrics = observation;
              try {
                const ownedBrowser = context.browser();
                if (!ownedBrowser) {
                  throw new Error("Active context has no owned Chromium browser");
                }
                processSession ??= await ownedBrowser.newBrowserCDPSession();
                observation.before = await rendererProcesses(processSession);
              } catch (error) {
                observation.error = String(error);
              }
            }
            const taskProbe = await page.evaluateHandle(() => {
              const durations: number[] = [];
              const observer = new PerformanceObserver((list) => {
                durations.push(...list.getEntries().map((entry) => entry.duration));
              });
              observer.observe({ type: "longtask" });
              return { durations, observer };
            });
            const before = await metrics(cdp);
            if (values["function-counts"]) {
              const artifact = `${artifactPrefix}.preparation-function-coverage.json`;
              await writeFile(
                path.join(artifactDir, artifact),
                JSON.stringify(await cdp.send("Profiler.takePreciseCoverage")),
              );
              result.functionCoveragePreparationArtifact = artifact;
            } else if (scenario.projectionFamily && values["projection-counts"]) {
              await cdp.send("Profiler.enable");
              await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
              preciseCoverage = true;
            }
            await page.evaluate(() => performance.mark("interaction:start"));
            if (values["graph-counts"]) {
              await page.evaluate((label) => {
                const graph = Reflect.get(window, "__openclawReactiveGraph");
                if (!graph) {
                  throw new Error("--graph-counts requires the explicit reactive graph build");
                }
                graph.start(label);
              }, scenario.id);
            }
            const start = performance.now();
            result.scenarioEvidence = (await scenario.run(page, gateway)) ?? undefined;
            if (scenario.visibility !== "hidden") {
              await settle(page);
            }
            result.wallMs = performance.now() - start;
            await page.evaluate(() => performance.mark("interaction:end"));
            if (values["graph-counts"]) {
              const graph = await page.evaluate(() =>
                Reflect.get(window, "__openclawReactiveGraph").stop(),
              );
              const artifact = `${artifactPrefix}.reactive-graph.json`;
              await writeFile(path.join(artifactDir, artifact), JSON.stringify(graph, null, 2));
              result.reactiveGraphArtifact = artifact;
            }
            if (preciseCoverage) {
              const coverage = await cdp.send("Profiler.takePreciseCoverage");
              await cdp.send("Profiler.stopPreciseCoverage");
              preciseCoverage = false;
              if (values["function-counts"]) {
                const artifact = `${artifactPrefix}.function-coverage.json`;
                await writeFile(path.join(artifactDir, artifact), JSON.stringify(coverage));
                result.functionCoverageArtifact = artifact;
              }
              if (scenario.projectionFamily && values["projection-counts"]) {
                const artifact = `${artifactPrefix}.projection-coverage.json`;
                await writeFile(path.join(artifactDir, artifact), JSON.stringify(coverage));
                result.projectionCoverageArtifact = artifact;
              }
            }
            const after = await metrics(cdp);
            if (processSession && result.rendererProcessMetrics?.before) {
              const observation = result.rendererProcessMetrics;
              try {
                observation.after = await rendererProcesses(processSession);
                const beforeRows = observation.before!;
                const afterRows = observation.after;
                if (
                  beforeRows.length !== afterRows.length ||
                  beforeRows.some(({ id }) => !afterRows.some((row) => row.id === id))
                ) {
                  throw new Error("Owned renderer process set changed during the interval");
                }
                const cpuSeconds = afterRows.reduce(
                  (sum, row) =>
                    sum + row.cpuSeconds - beforeRows.find(({ id }) => id === row.id)!.cpuSeconds,
                  0,
                );
                if (cpuSeconds < 0) {
                  throw new Error("Owned renderer CPU counters moved backwards");
                }
                result.rendererCpuMs = cpuSeconds * 1000;
                result.rendererRssBeforeBytes = beforeRows.reduce(
                  (sum, row) => sum + row.rssBytes,
                  0,
                );
                result.rendererRssAfterBytes = afterRows.reduce(
                  (sum, row) => sum + row.rssBytes,
                  0,
                );
                observation.complete = true;
              } catch (error) {
                observation.error = String(error);
              }
            }
            result.heapBeforeBytes = before.JSHeapUsedSize;
            result.heapAfterBytes = after.JSHeapUsedSize;
            result.heapDeltaBytes = after.JSHeapUsedSize - before.JSHeapUsedSize;
            result.longTasks = await taskProbe.evaluate(({ durations, observer }) => {
              durations.push(...observer.takeRecords().map((entry) => entry.duration));
              observer.disconnect();
              return {
                count: durations.length,
                totalMs: durations.reduce((sum, duration) => sum + duration, 0),
                maxMs: Math.max(0, ...durations),
              };
            });
            await taskProbe.dispose();
            if (processSession && processWakeupReader && result.processWakeups?.before) {
              try {
                result.processWakeups.after = await readProcessWakeups(
                  processSession,
                  processWakeupReader,
                  ownedBrowserPid,
                );
                finishProcessWakeups(result.processWakeups);
              } catch (error) {
                result.processWakeups.reason = String(error);
              }
            }
            const requestsAfter = (await gateway.getRequests()).slice(requestsBefore);
            result.domAfter = await countDom();
            if (scenario.projectionFamily) {
              if (minimizedWindow !== undefined) {
                await cdp.send("Browser.setWindowBounds", {
                  windowId: minimizedWindow,
                  bounds: { windowState: "normal" },
                });
                minimizedWindow = undefined;
                await page.waitForFunction(() => document.visibilityState === "visible");
              }
              if (pair === 0 && !scenario.projectionIdle) {
                const artifact = `${artifactPrefix}.projection-mounted.png`;
                await page.screenshot({ path: path.join(artifactDir, artifact) });
                result.projectionScreenshotArtifact = artifact;
              }
              result.projectionFixture = await finishProjectionFixture(page);
            }
            if (rowProbe && scenario.rowSelector) {
              result.rowIdentity = await rowProbe.evaluate(({ state, observer }, selector) => {
                observer.disconnect();
                const current = new Set(document.querySelectorAll(selector));
                return {
                  initial: state.original.length,
                  created: state.created,
                  retained: state.original.filter((row) => current.has(row)).length,
                  final: current.size,
                };
              }, scenario.rowSelector);
              await rowProbe.dispose();
            }
            if (values["resource-counts"]) {
              result.resourcesAfter = await readControlUiResourceCounts(page);
            }
            for (const [key, name] of [
              ["scriptMs", "ScriptDuration"],
              ["taskMs", "TaskDuration"],
              ["layoutMs", "LayoutDuration"],
              ["styleMs", "RecalcStyleDuration"],
            ] as const) {
              if (before[name] === undefined || after[name] === undefined) {
                throw new Error(`Missing ${name}`);
              }
              result[key] = (after[name] - before[name]) * 1000;
            }
            result.durationBreakdownMs = Object.fromEntries(
              Object.entries(after)
                .filter(([name]) => name.endsWith("Duration"))
                .map(([name, value]) => [name, (value - before[name]!) * 1000]),
            );
            result.requests = {};
            for (const request of requestsAfter) {
              result.requests[request.method] = (result.requests[request.method] ?? 0) + 1;
            }
            if (scenario.projectionFamily) {
              const sdk =
                scenario.projectionFamily === "sdk-avatars" ||
                scenario.projectionFamily === "sdk-avatar-identities";
              const resourceFamily = [
                "tooltips",
                "link-providers",
                "link-metadata",
                "ci-pairs",
                "clawhub-cards",
              ].includes(scenario.projectionFamily);
              const method =
                scenario.projectionFamily === "board-pins"
                  ? "board.get"
                  : scenario.projectionFamily === "ci-pairs"
                    ? "controlUi.sessionPullRequests.checks"
                    : scenario.projectionFamily === "clawhub-cards"
                      ? "plugins.catalog.get"
                      : resourceFamily
                        ? "forge.detail"
                        : scenario.projectionFamily === "sdk-avatar-identities"
                          ? "agent.identity.get"
                          : "agents.list";
              const expected = scenario.projectionIdle || resourceFamily ? 0 : sdk ? 10 : 20;
              if ((result.requests[method] ?? 0) !== expected) {
                throw new Error(
                  `Expected ${expected} measured ${method} requests, got ${result.requests[method] ?? 0}`,
                );
              }
            }
            if (errors.length) {
              throw new Error(errors.join("\n"));
            }
            result.status = "passed";
          } catch (error) {
            if (error instanceof ScenarioSkipped) {
              result.status = "skipped";
              result.skipReason = error.message;
            } else {
              result.error = String(error);
            }
          } finally {
            const capture = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
              try {
                return await operation();
              } catch (error) {
                result.status = "failed";
                result.error = [result.error, String(error)].filter(Boolean).join("\n");
                return undefined;
              }
            };
            try {
              if (preciseCoverage && cdp) {
                await capture(() => cdp!.send("Profiler.stopPreciseCoverage"));
              }
              if (minimizedWindow !== undefined && cdp) {
                const windowId = minimizedWindow;
                await capture(() =>
                  cdp!.send("Browser.setWindowBounds", {
                    windowId,
                    bounds: { windowState: "normal" },
                  }),
                );
              }
              if (values["resource-counts"] && !result.resourcesAfter) {
                result.resourcesAfter = await capture(() => readControlUiResourceCounts(page));
              }
              const profile =
                profiling && cdp
                  ? await capture(async () => (await cdp!.send("Profiler.stop")).profile)
                  : undefined;
              if (profile) {
                await capture(() =>
                  writeFile(
                    path.join(artifactDir, `${artifactPrefix}.cpuprofile`),
                    JSON.stringify(profile),
                  ),
                );
              }
              if (tracing && cdp) {
                await capture(async () => {
                  const complete = new Promise<void>((resolve) => {
                    cdp!.once("Tracing.tracingComplete", () => resolve());
                  });
                  await cdp!.send("Tracing.end");
                  await complete;
                  await writeFile(
                    path.join(artifactDir, `${artifactPrefix}.trace.json`),
                    JSON.stringify({ traceEvents: events }),
                  );
                  if (result.status === "passed") {
                    result.trace = summarizeInteractionTrace(events, {
                      start: "interaction:start",
                      end: "interaction:end",
                    });
                    if (values["selector-stats"]) {
                      const selectors = summarizeInteractionSelectors(
                        events,
                        result.trace,
                        styleSheets,
                      );
                      const artifact = `${artifactPrefix}.selectors.json`;
                      await writeFile(
                        path.join(artifactDir, artifact),
                        JSON.stringify(selectors, null, 2),
                      );
                      result.selectorStats = {
                        artifact,
                        stylePasses: selectors.stylePasses,
                        selectorCount: selectors.selectors.length,
                      };
                    }
                    if (profile) {
                      const clipped = clipInteractionCpuProfile(
                        profile,
                        result.trace.startUs,
                        result.trace.endUs,
                      );
                      const mapped = await mapColdLoadCpuProfile(clipped, {
                        assetBaseUrl: new URL("assets/", slot.server.baseUrl).href,
                        assetDirectory: path.join(slot.directory, "assets"),
                      });
                      result.longTaskDetails = summarizeLongTaskCpuProfiles(
                        {
                          ...mapped.profile,
                          startTime: clipped.startTime,
                          endTime: clipped.endTime,
                        },
                        result.trace.longTaskIntervals,
                      );
                      await writeFile(
                        path.join(artifactDir, `${artifactPrefix}.hotspots.json`),
                        JSON.stringify(
                          {
                            mappedFrames: mapped.mappedFrames,
                            unmappedFrames: mapped.unmappedFrames,
                            longTasks: result.longTaskDetails,
                            ...summarizeCpuProfile(mapped.profile, { includeTables: true }),
                          },
                          null,
                          2,
                        ),
                      );
                    }
                  }
                });
              }
              const retainedHeap = result.retainedHeap;
              if (values["retained-heap"] && cdp && retainedHeap && result.status === "passed") {
                await capture(async () => {
                  await cdp!.send("HeapProfiler.collectGarbage");
                  const final = await metrics(cdp!);
                  if (final.JSHeapUsedSize === undefined) {
                    throw new Error("Missing JSHeapUsedSize after final garbage collection");
                  }
                  retainedHeap.afterBytes = final.JSHeapUsedSize;
                  retainedHeap.deltaBytes = final.JSHeapUsedSize - retainedHeap.beforeBytes;
                });
              }
              if (!values["first-pair-screenshots"] || pair === 0 || result.status === "failed") {
                await capture(() =>
                  page.screenshot({ path: path.join(artifactDir, `${artifactPrefix}.png`) }),
                );
              }
            } finally {
              if (processSession) {
                try {
                  await processSession.detach();
                } catch (error) {
                  if (result.processWakeups) {
                    result.processWakeups.complete = false;
                    delete result.processWakeups.delta;
                    result.processWakeups.reason = `Process session cleanup failed: ${String(error)}`;
                  }
                  if (result.rendererProcessMetrics) {
                    result.rendererProcessMetrics.complete = false;
                    delete result.rendererCpuMs;
                    result.rendererProcessMetrics.error = `Process session cleanup failed: ${String(error)}`;
                  }
                }
              }
              if (scenario.projectionFamily) {
                await capture(() => disposeProjectionFixture(page));
              }
              await capture(async () => cdp?.detach());
              await capture(() =>
                nativeVisibility
                  ? nativeVisibility.close()
                  : observationBrowser
                    ? observationBrowser.close()
                    : context.close(),
              );
            }
            if (errors.length) {
              result.status = "failed";
              result.error = [result.error, ...errors].filter(Boolean).join("\n");
            }
            await writeFile(
              path.join(artifactDir, `${artifactPrefix}.status.json`),
              JSON.stringify({ ...result, errors }, null, 2),
            );
          }
          results.push(result);
          await writeFile(path.join(artifactDir, "results.json"), JSON.stringify(results, null, 2));
          console.log(JSON.stringify(result));
        }
        pairHostObservations.push({
          step: scenario.id,
          viewport: viewport.name,
          pair,
          startedAt,
          startLoad,
          endedAt: new Date().toISOString(),
          endLoad: os.loadavg(),
        });
        await writeFile(
          path.join(artifactDir, "pair-host-load.json"),
          JSON.stringify(pairHostObservations, null, 2),
        );
      }
    }
  }
} finally {
  await browser.close();
  if (sandboxServer?.listening) {
    sandboxServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      sandboxServer!.close((error) => (error ? reject(error) : resolve()));
    });
  }
  for (const { server } of servers) {
    await server.close();
  }
}
const summary = viewports
  .flatMap(({ name }) =>
    scenarios.flatMap(({ id, diagnostic }) =>
      servers.map((_, bundle) => {
        const samples = results.filter(
          (row) =>
            row.viewport === name &&
            row.step === id &&
            row.bundle === bundle &&
            row.status === "passed",
        );
        return {
          viewport: name,
          step: id,
          bundle,
          passed: samples.length,
          failed: results.filter(
            (row) =>
              row.viewport === name &&
              row.step === id &&
              row.bundle === bundle &&
              row.status === "failed",
          ).length,
          skipped: results.filter(
            (row) =>
              row.viewport === name &&
              row.step === id &&
              row.bundle === bundle &&
              row.status === "skipped",
          ).length,
          trace:
            trace && samples.length
              ? Object.fromEntries(
                  (
                    [
                      "busyMs",
                      "longTasks",
                      "longTaskMs",
                      "longestTaskMs",
                      "scriptMs",
                      "layoutMs",
                      "styleMs",
                    ] as const
                  ).map((metric) => [
                    metric,
                    distribution(samples.map((row) => row.trace![metric])),
                  ]),
                )
              : undefined,
          metrics: Object.fromEntries(
            (
              [
                "wallMs",
                "scriptMs",
                "taskMs",
                "layoutMs",
                "styleMs",
                ...(values["renderer-process-metrics"] ? ["rendererCpuMs" as const] : []),
              ] as const
            ).map((metric) => [
              metric,
              !diagnostic &&
              !values["function-counts"] &&
              samples.length &&
              !values["projection-counts"] &&
              samples.every((row) => row[metric] !== undefined)
                ? distribution(samples.map((row) => row[metric]!))
                : null,
            ]),
          ),
        };
      }),
    ),
  )
  .toSorted((a, b) => (b.metrics.scriptMs?.median ?? 0) - (a.metrics.scriptMs?.median ?? 0));
const compareBundle = (bundle: number) =>
  summary
    .filter((row) => row.bundle === 0)
    .flatMap((baseline) => {
      const candidate = summary.find(
        (row) =>
          row.bundle === bundle && row.viewport === baseline.viewport && row.step === baseline.step,
      );
      if (!candidate) {
        return [];
      }
      return Object.entries(baseline.metrics).flatMap(([metric, before]) => {
        const after = candidate.metrics[metric];
        if (!before || !after) {
          return [];
        }
        return (["median", "p95", "min", "max"] as const).map((statistic) => ({
          viewport: baseline.viewport,
          step: baseline.step,
          metric,
          statistic,
          before: before[statistic],
          after: after[statistic],
          percent: before[statistic] ? (after[statistic] / before[statistic] - 1) * 100 : null,
          regression: after[statistic] > before[statistic] * 1.2,
        }));
      });
    });
const comparisons = compareBundle(1);
const controlComparisons = values["control-bundle-dir"] ? compareBundle(2) : undefined;
await writeFile(
  path.join(artifactDir, "summary.json"),
  JSON.stringify(
    {
      comparisons,
      controlComparisons,
      planned: viewports.length * scenarios.length * pairs * servers.length,
      executed: results.length,
      failed: results.filter((row) => row.status === "failed").length,
      skipped: results.filter((row) => row.status === "skipped").length,
      processWakeupsIncomplete: values["process-wakeups"]
        ? results.filter((row) => row.processWakeups?.complete !== true).length
        : undefined,
      rendererProcessMetricsIncomplete: values["renderer-process-metrics"]
        ? results.filter((row) => row.rendererProcessMetrics?.complete !== true).length
        : undefined,
      summary,
    },
    null,
    2,
  ),
);
const escapeHtml = (value: unknown) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const rows = summary
  .map((row) => {
    const representative = results.find(
      (result) =>
        result.step === row.step &&
        result.viewport === row.viewport &&
        result.bundle === row.bundle,
    );
    const metric = (name: "scriptMs" | "taskMs" | "layoutMs" | "styleMs") => {
      const value = row.metrics[name];
      return value
        ? `${value.median.toFixed(1)} / ${value.p95.toFixed(1)} / ${value.min.toFixed(1)}–${value.max.toFixed(1)}`
        : "—";
    };
    const links = representative
      ? [
          "png",
          "status.json",
          ...(trace && representative.trace ? ["trace.json", "hotspots.json", "cpuprofile"] : []),
          ...(representative.selectorStats ? ["selectors.json"] : []),
        ]
          .map(
            (suffix) =>
              `<a href="${escapeHtml(representative.artifactPrefix)}.${suffix}">${suffix}</a>`,
          )
          .join(" ")
      : "";
    return `<tr><td>${escapeHtml(row.viewport)}</td><td>${escapeHtml(row.step)}</td><td>${row.bundle}</td><td>${row.passed}/${row.failed}/${row.skipped}</td><td>${metric("scriptMs")}</td><td>${metric("taskMs")}</td><td>${metric("layoutMs")}</td><td>${metric("styleMs")}</td><td>${row.trace?.longTasks?.median ?? "—"}</td><td>${links}</td></tr>`;
  })
  .join("\n");
await writeFile(
  path.join(artifactDir, "report.html"),
  `<!doctype html><meta charset="utf-8"><title>Warm interactions</title><style>body{font:15px system-ui;padding:24px}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #bbb;text-align:left}a{margin-right:6px}</style><h1>Production-renderer warm interactions</h1><p>${trace ? "Trace and CPU sampling overhead included." : "Untraced CDP metric deltas."} ${values["selector-stats"] ? "CSS selector instrumentation overhead included; selectors ranked by elapsed microseconds." : ""} Theme: ${theme}. Cells: median / p95 / min–max (ms). Wall time in JSON is automation-to-assertion, not INP. Synthetic Gateway; native clocks. <a href="manifest.json">Manifest</a> <a href="summary.json">Summary</a></p><table><tr><th>Viewport</th><th>Step</th><th>Bundle</th><th>Pass/fail/skip</th><th>Script</th><th>Task</th><th>Layout</th><th>Style</th><th>Long tasks</th><th>Evidence</th></tr>${rows}</table>`,
);
console.log(`Warm interaction artifacts: ${artifactDir}`);
if (results.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}
