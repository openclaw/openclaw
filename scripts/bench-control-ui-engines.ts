// Cross-engine companion to the CDP-only cold-load and interaction benchmarks.
// Uses their production HTTP server, synthetic Gateway, scenarios and assertions.
// Long-tail sweep: --pages --engines chromium --cpu-throttle 4 --viewport both
// Run Chromium at 1x and WebKit separately; --steps page-<route>-<phase> narrows follow-ups.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  chromium as chromiumEngine,
  firefox as firefoxEngine,
  webkit as webkitEngine,
  type Browser,
} from "playwright";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../ui/src/test-helpers/control-ui-plugin-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  mapControlUiAllocationProfile,
  summarizeControlUiAllocations,
} from "./lib/control-ui-allocation-profile.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { controlUiBenchOrder } from "./lib/control-ui-bench-order.ts";
import {
  createChatComposerScenarios,
  installChatActionObservation,
  readChatActionObservation,
} from "./lib/control-ui-chat-composer-scenarios.ts";
import { createChatMessageScenarios } from "./lib/control-ui-chat-message-scenarios.ts";
import { createChatPanelScenarios } from "./lib/control-ui-chat-panel-scenarios.ts";
import {
  mapColdLoadCpuProfile,
  type ColdLoadCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import { createControlUiCpuCensus } from "./lib/control-ui-cpu-census.ts";
import { createEngineActionScenarios } from "./lib/control-ui-engine-action-scenarios.ts";
import {
  createEngineActionTiming,
  type EngineActionTiming,
} from "./lib/control-ui-engine-action-timing.ts";
import {
  createEngineBootScenarios,
  type EngineScenario,
} from "./lib/control-ui-engine-boot-scenarios.ts";
import { createEngineCompletedRunScenarios } from "./lib/control-ui-engine-completed-run-scenarios.ts";
import {
  installEngineConfigurationObserver,
  readEngineConfigurationObservation,
} from "./lib/control-ui-engine-configuration-observer.ts";
import { resolveEngineConfigurations } from "./lib/control-ui-engine-configurations.ts";
import {
  createEngineIdleControls,
  createEngineIdleScenarios,
  isEngineIdleControl,
  isEngineIdleScenario,
  readEngineIdleState,
  verifyEngineIdleClocks,
} from "./lib/control-ui-engine-idle-scenarios.ts";
import { createEngineMemoryScenarios } from "./lib/control-ui-engine-memory-scenarios.ts";
import { createEngineMemoryCollector } from "./lib/control-ui-engine-memory.ts";
import {
  startEngineMeasurement,
  type ControlUiEngine,
  type EngineMetrics,
} from "./lib/control-ui-engine-metrics.ts";
import {
  collectEnginePageStructure,
  createEnginePageScenarios,
  enginePageCoverage,
  enginePageFixtureCounts,
  createEngineRouteTransitionScenarios,
  engineRouteTransitionCoverage,
  type EngineRouteTransition,
} from "./lib/control-ui-engine-page-scenarios.ts";
import { createEnginePluginMemoryScenarios } from "./lib/control-ui-engine-plugin-memory-scenarios.ts";
import { createEngineStreamingScenarios } from "./lib/control-ui-engine-streaming-scenarios.ts";
import { createEngineStyleScenarios } from "./lib/control-ui-engine-style-scenarios.ts";
import { frames } from "./lib/control-ui-interaction-navigation.ts";
import {
  createScenarioFixture,
  interactionScenarios,
  installInteractionNavigationPreloadObserver,
  settleInteractionNavigationPreloads,
  type InteractionNavigationPreloads,
  type InteractionEvidence,
} from "./lib/control-ui-interaction-scenarios.ts";
import {
  createControlUiLayerAudit,
  type ControlUiLayerAudit,
} from "./lib/control-ui-layer-audit.ts";
import {
  compareControlUiScreenshots,
  createControlUiMutationAudit,
  type ControlUiMutationAudit,
} from "./lib/control-ui-mutation-audit.ts";
import { summarizeControlUiNativeTrace } from "./lib/control-ui-native-trace.ts";
import { createControlUiObservationWriter } from "./lib/control-ui-observation-output.ts";
import {
  finishControlUiPageObserver,
  installControlUiPageObserver,
  readControlUiPageObserver,
  resetControlUiPageObserver,
  type ControlUiPageObservation,
} from "./lib/control-ui-page-observer.ts";
import {
  createControlUiRemountAudit,
  type ControlUiRemountAudit,
} from "./lib/control-ui-remount-audit.ts";
import { createEngineRemountScenarios } from "./lib/control-ui-remount-scenarios.ts";
import { installControlUiResourceCounts } from "./lib/control-ui-resource-counts.ts";
import { launchTalkObservationBrowser } from "./lib/control-ui-talk-fixture.ts";
import {
  createWorkboardResourceFixture,
  prepareWorkboardResourceSource,
} from "./lib/control-ui-workboard-resource-fixture.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    "control-bundle-dir": { type: "string", multiple: true },
    "source-root": { type: "string", default: "." },
    "compare-source-root": { type: "string" },
    "control-source-root": { type: "string", multiple: true },
    output: { type: "string", default: ".artifacts/control-ui-engines" },
    engines: { type: "string", default: "chromium,webkit" },
    "network-profiles": { type: "string", default: "localhost" },
    configurations: { type: "string", default: "default" },
    viewport: { type: "string", default: "both" },
    steps: { type: "string" },
    pages: { type: "boolean", default: false },
    "page-phases": { type: "string", default: "visit,action,leave" },
    "page-origin": { type: "string", default: "new-session" },
    pairs: { type: "string", default: "1" },
    trace: { type: "boolean", default: false },
    "observer-origins": { type: "boolean", default: false },
    "cpu-only": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "native-audit": { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    "mutation-audit": { type: "boolean", default: false },
    "remount-audit": { type: "boolean", default: false },
    "route-transitions": { type: "boolean", default: false },
    "transition-targets": { type: "string" },
    "cpu-throttle": { type: "string", default: "1" },
    "idle-warmup-ms": { type: "string" },
    "idle-duration-ms": { type: "string", default: "30000" },
    "memory-soak-rounds": { type: "string", default: "10" },
  },
});
const pairs = Number(values.pairs);
const configurations = resolveEngineConfigurations(values.configurations);
const memorySoakRounds = Number(values["memory-soak-rounds"]);
if (!Number.isInteger(memorySoakRounds) || memorySoakRounds < 1 || memorySoakRounds > 10) {
  throw new Error("memory-soak-rounds must be an integer from 1 to 10");
}
const pageBenchmark = values.pages || values.steps?.split(",").some((id) => id.startsWith("page-"));
const pagePhases = values["page-phases"].split(",");
const pageOrigin = values["page-origin"];
if (pageOrigin !== "new-session" && pageOrigin !== "chat") {
  throw new Error("page-origin must be new-session or chat");
}
if (pagePhases.some((phase) => !["visit", "revisit", "action", "leave"].includes(phase))) {
  throw new Error("page-phases must contain visit, revisit, action and/or leave");
}
const engines: ControlUiEngine[] = values.engines.split(",").map((name) => {
  if (name !== "chromium" && name !== "webkit" && name !== "firefox") {
    throw new Error(`Unsupported engine: ${name}`);
  }
  return name;
});
const cpuThrottle = Number(values["cpu-throttle"]);
const idleDurationMs = Number(values["idle-duration-ms"]);
if (!Number.isInteger(idleDurationMs) || idleDurationMs <= 0) {
  throw new Error("idle-duration-ms must be a positive integer");
}
const idleWarmupOverrideMs =
  values["idle-warmup-ms"] === undefined ? undefined : Number(values["idle-warmup-ms"]);
if (
  idleWarmupOverrideMs !== undefined &&
  (!Number.isInteger(idleWarmupOverrideMs) || idleWarmupOverrideMs < 0)
) {
  throw new Error("idle-warmup-ms must be a non-negative integer");
}
const resolveIdleWarmupMs = (scenario: EngineScenario) =>
  isEngineIdleScenario(scenario)
    ? (idleWarmupOverrideMs ?? (scenario.visibility === "hidden" ? 60_000 : 0))
    : 0;
if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
  throw new Error("cpu-throttle must be at least 1");
}
if (cpuThrottle !== 1 && engines.some((engine) => engine !== "chromium")) {
  throw new Error(
    "Only Chromium exposes CPU throttling; use --engines chromium for throttled runs",
  );
}
if (
  engines.includes("firefox") &&
  (values.trace ||
    values["cpu-only"] ||
    values["cpu-profile"] ||
    values["native-audit"] ||
    values.allocations)
) {
  throw new Error(
    "Firefox supports application elapsed timing, not CPU counters or native traces in this harness",
  );
}
const networkProfiles = values["network-profiles"].split(",").map((name) => {
  if (name !== "localhost" && name !== "rtt-100ms" && name !== "rtt-250ms") {
    throw new Error(`Unsupported network profile: ${name}`);
  }
  const latencyMs = name === "localhost" ? 0 : name === "rtt-100ms" ? 100 : 250;
  return { name, httpLatencyMs: latencyMs, gatewayLatencyMs: latencyMs };
});
type NetworkProfile = (typeof networkProfiles)[number];
if (new Set(networkProfiles.map(({ name }) => name)).size !== networkProfiles.length) {
  throw new Error("Use distinct --network-profiles");
}
if (!Number.isInteger(pairs) || pairs < 1 || new Set(engines).size !== engines.length) {
  throw new Error("Use positive integer --pairs and distinct engines");
}
if (!["desktop", "mobile", "both"].includes(values.viewport)) {
  throw new Error("Invalid viewport");
}
if (values.steps?.split(",").includes("streaming-mixed-fast") && values.viewport !== "desktop") {
  throw new Error(
    "streaming-mixed-fast requires --viewport desktop: concurrent composer and sidebar input needs non-modal navigation",
  );
}
if (values["control-bundle-dir"]?.length && !values["compare-bundle-dir"]) {
  throw new Error("--control-bundle-dir requires --compare-bundle-dir");
}
if (values.trace && values["cpu-only"]) {
  throw new Error("Choose --trace or --cpu-only; use separate untraced timing runs");
}
if (
  (values["mutation-audit"] || values["remount-audit"]) &&
  (values.trace || values["cpu-only"] || values["cpu-profile"] || values["native-audit"])
) {
  throw new Error(
    "Mutation/remount audits are diagnostic; collect profiles and timings separately",
  );
}
if (values["cpu-profile"] && (values.trace || values["cpu-only"] || engines.includes("webkit"))) {
  throw new Error("--cpu-profile requires Chromium and a separate run from --trace/--cpu-only");
}
if (
  values["native-audit"] &&
  (engines.includes("webkit") || values.trace || values["cpu-only"] || values["cpu-profile"])
) {
  throw new Error("--native-audit requires Chromium and a separate run from other profiling modes");
}
if (
  values.allocations &&
  (engines.includes("webkit") ||
    values.trace ||
    values["cpu-only"] ||
    values["cpu-profile"] ||
    values["native-audit"] ||
    values["mutation-audit"])
) {
  throw new Error("--allocations requires Chromium and a separate run from other profiling modes");
}
const artifactDir = createControlUiE2eArtifactDir("engines", values.output);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
].filter(({ name }) => values.viewport === "both" || name === values.viewport);
const directories = [
  values["bundle-dir"],
  values["compare-bundle-dir"],
  ...(values["control-bundle-dir"] ?? []),
].filter((directory): directory is string => Boolean(directory));
const sourceRoots = [
  values["source-root"],
  values["compare-source-root"],
  ...(values["control-source-root"] ?? []),
];
const needsWorkboard =
  values["route-transitions"] ||
  values.pages ||
  values.steps
    ?.split(",")
    .some(
      (id) =>
        id.startsWith("workboard-") ||
        (id.startsWith("remount-from-") &&
          (id === "remount-from-plugin" ||
            id === "remount-from-workboard" ||
            !values["transition-targets"] ||
            values["transition-targets"]
              .split(",")
              .some((target) => /^\/(?:plugin|workboard)(?:[/?]|$)/u.test(target)))) ||
        id.startsWith("noop-workboard-") ||
        /^page-(?:workboard|plugin)-(?:visit|revisit|action|leave)$/u.test(id),
    );
if (needsWorkboard && directories.some((_, index) => !sourceRoots[index])) {
  throw new Error("Workboard comparisons require a source root for each bundle");
}
const servers: Array<{
  directory: string;
  build: { buildId: string; version: string };
  sha256: string;
  workboardSource?: Awaited<ReturnType<typeof prepareWorkboardResourceSource>>;
  server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
}> = [];
const browsers = new Map<ControlUiEngine, Browser>();
const launchEngine = (engine: ControlUiEngine) =>
  engine === "webkit"
    ? webkitEngine.launch({ headless: true })
    : engine === "firefox"
      ? firefoxEngine.launch({ headless: true })
      : chromiumEngine.launch({
          headless: true,
          executablePath: resolvePlaywrightChromiumExecutablePath(chromiumEngine.executablePath()),
        });

function processMemory(browser: Browser) {
  // Pinned Playwright owns this child. Never include unrelated browser processes.
  const localBrowser = browser as Browser & {
    _connection: {
      toImpl(browser: Browser): { options: { browserProcess: { process: { pid: number } } } };
    };
  };
  // eslint-disable-next-line no-underscore-dangle -- Pinned Playwright's local browser process owner.
  const pid = localBrowser._connection.toImpl(browser).options.browserProcess.process.pid;
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const [id, parent, kib] = line.trim().split(/\s+/u).map(Number);
      return { id: id!, parent: parent!, bytes: kib! * 1024 };
    });
  const owned = new Set([pid]);
  let previousSize = 0;
  while (previousSize !== owned.size) {
    previousSize = owned.size;
    for (const row of rows) {
      if (owned.has(row.parent)) {
        owned.add(row.id);
      }
    }
  }
  const processes = rows.filter((row) => owned.has(row.id));
  if (!processes.some((row) => row.id === pid)) {
    throw new Error("Browser process exited before memory sample");
  }
  return {
    rootPid: pid,
    processes: processes.length,
    processTreeRssBytes: processes.reduce((sum, row) => sum + row.bytes, 0),
  };
}
let planned = 0;
type Observation = {
  configuration: string;
  configurationEvidence?: Awaited<ReturnType<typeof readEngineConfigurationObservation>>;
  engine: ControlUiEngine;
  networkProfile: NetworkProfile["name"];
  viewport: string;
  step: string;
  bundle: number;
  pair: number;
  position: number;
  status: "passed" | "failed" | "skipped";
  skipReason?: string;
  wallMs?: number;
  scenarioMs?: number;
  settleWaitMs?: number;
  actionTiming?: EngineActionTiming;
  prepareFrameIntervalMs?: number;
  settleFrameIntervalMs?: number;
  hostLoadAverage: number[];
  metrics?: EngineMetrics;
  pageMetrics?: ControlUiPageObservation;
  native?: ReturnType<typeof summarizeControlUiNativeTrace>;
  allocations?: ReturnType<typeof summarizeControlUiAllocations> & {
    mappedFrames: number;
    unmappedFrames: number;
  };
  mutations?: ControlUiMutationAudit;
  remounts?: ControlUiRemountAudit;
  transitions?: Array<
    EngineRouteTransition & {
      metrics?: EngineMetrics;
      remounts?: ControlUiRemountAudit;
      wallMs: number;
      applicationMs?: number;
      error?: string;
    }
  >;
  pixels?: Awaited<ReturnType<typeof compareControlUiScreenshots>>;
  computedTheme?: Record<string, string>;
  layers?: ControlUiLayerAudit;
  idle?: {
    warmupMs: number;
    before: Awaited<ReturnType<typeof readEngineIdleState>>;
    after?: Awaited<ReturnType<typeof readEngineIdleState>>;
    revealed?: Awaited<ReturnType<typeof readEngineIdleState>>;
    fixture: { sessions: number; transcriptMessages: number };
    clockRecovery?: Awaited<ReturnType<typeof verifyEngineIdleClocks>>;
    taskMsPerMinute?: number | null;
    scriptMsPerMinute?: number | null;
    resourceIntervalMs?: number;
    layerIntervalMs?: number;
  };
  requests?: Record<string, number>;
  evidence?: InteractionEvidence;
  navigationPreloads?: InteractionNavigationPreloads;
  retiredProcess?: ReturnType<typeof processMemory>;
  memory?: Array<{
    checkpoint: string;
    timeOrigin: { initial: number; current: number };
    clearedFixtureRequests: number;
    metrics: Awaited<
      ReturnType<Awaited<ReturnType<typeof createEngineMemoryCollector>>["capture"]>
    >;
    resources: unknown;
    process: ReturnType<typeof processMemory>;
  }>;
  error?: string;
  errorEvents?: Array<{ message: string; phase: string }>;
  resizeErrorCount: number;
  artifactPrefix: string;
};
const observations: Observation[] = [];
const observationWriter = createControlUiObservationWriter(artifactDir);
const cpuCensus = createControlUiCpuCensus();
const writeJson = (name: string, value: unknown) =>
  writeFile(path.join(artifactDir, name), JSON.stringify(value, null, 2));
try {
  for (const [index, directory] of directories.entries()) {
    const resolved = path.resolve(directory);
    const html = await readFile(path.join(resolved, "index.html"), "utf8");
    const raw = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!raw) {
      throw new Error(`Missing build identity: ${resolved}`);
    }
    const normalized = normalizeControlUiBuildInfo(JSON.parse(raw));
    if (!normalized.version) {
      throw new Error(`Missing build version: ${resolved}`);
    }
    const build = { buildId: normalized.buildId, version: normalized.version };
    servers.push({
      directory: resolved,
      build,
      sha256: createHash("sha256").update(html).digest("hex"),
      workboardSource: needsWorkboard
        ? await prepareWorkboardResourceSource(sourceRoots[index]!)
        : undefined,
      server: await startControlUiBenchGatewayServer(resolved),
    });
  }
  for (const engine of engines) {
    browsers.set(engine, await launchEngine(engine));
  }
  const requestedIds = values.steps?.split(",");
  const catalog: EngineScenario[] = [
    ...createEngineBootScenarios(servers[0]!.server.baseUrl),
    ...createEngineActionScenarios(),
    ...createEngineCompletedRunScenarios(servers[0]!.server.baseUrl),
    ...createEngineIdleScenarios(idleDurationMs),
    ...createEngineIdleControls(idleDurationMs),
    ...createChatComposerScenarios(),
    ...createChatMessageScenarios(),
    ...createChatPanelScenarios().map((scenario) =>
      Object.assign(scenario, { explicitOnly: true }),
    ),
    ...createEngineStyleScenarios(),
    ...createEngineMemoryScenarios(memorySoakRounds),
    ...createEnginePluginMemoryScenarios(),
    ...createEngineStreamingScenarios(),
    ...createEnginePageScenarios(0, pageOrigin, servers[0]!.server.baseUrl),
    ...createEngineRemountScenarios(),
    ...createEngineRouteTransitionScenarios(async (_page, _transition, run) => {
      await run();
    }, values["transition-targets"]?.split(",")),
    ...interactionScenarios.filter(
      (scenario) =>
        requestedIds?.includes(scenario.id) ||
        (!scenario.explicitOnly &&
          !scenario.resourceOnly &&
          !scenario.projectionFamily &&
          !scenario.dataPage),
    ),
  ];
  const ids = requestedIds?.flatMap((id) =>
    id === "remount-interactions"
      ? catalog
          .filter(
            (scenario) =>
              scenario.id.startsWith("remount-") && !scenario.id.startsWith("remount-from-"),
          )
          .map((scenario) => scenario.id)
      : id === "chat-actions"
        ? catalog
            .filter((scenario) => scenario.id.startsWith("chat-actions-"))
            .map((scenario) => scenario.id)
        : [id],
  );
  const scenarios = catalog.filter(({ id, explicitOnly, memory }) =>
    ids
      ? ids.some((selected) => selected === id || (selected === "memory" && memory))
      : values["route-transitions"]
        ? id.startsWith("remount-from-")
        : values.pages
          ? id.startsWith("page-") && pagePhases.some((phase) => id.endsWith(`-${phase}`))
          : !explicitOnly,
  );
  if (
    !scenarios.length ||
    ids?.some((id) => id !== "memory" && !scenarios.some((scenario) => scenario.id === id))
  ) {
    throw new Error("Unknown or empty --steps selection");
  }
  if (pageOrigin === "chat" && scenarios.some((scenario) => scenario.fixture?.workboardResources)) {
    throw new Error("Workboard/plugin resource fixtures require --page-origin new-session");
  }
  if (engines.includes("firefox") && scenarios.some((scenario) => scenario.memory)) {
    throw new Error(
      "Firefox does not expose forced GC or heap snapshots in this harness; select non-memory steps",
    );
  }
  if (
    networkProfiles.some(({ name }) => name !== "localhost") &&
    scenarios.some(
      ({ id }) =>
        id !== "cold-boot" && id !== "warm-boot" && !/^page-.+-(?:visit|revisit)$/u.test(id),
    )
  ) {
    throw new Error(
      "Nonlocal --network-profiles require cold-boot, warm-boot or page-<route>-visit/revisit steps",
    );
  }
  planned =
    scenarios.length *
    viewports.length *
    pairs *
    engines.length *
    servers.length *
    configurations.length *
    networkProfiles.length;
  await writeJson("manifest.json", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    harnessSources: Object.fromEntries(
      await Promise.all(
        [
          "./bench-control-ui-engines.ts",
          "./lib/control-ui-engine-metrics.ts",
          "./lib/control-ui-layer-audit.ts",
          "./lib/control-ui-native-trace.ts",
          "./lib/control-ui-mutation-audit.ts",
          "./lib/control-ui-cold-load-trace.ts",
          "./lib/control-ui-cpu-census.ts",
          "./lib/control-ui-allocation-profile.ts",
          "./lib/control-ui-engine-boot-scenarios.ts",
          "./lib/control-ui-engine-completed-run-scenarios.ts",
          "./lib/control-ui-engine-idle-scenarios.ts",
          "./lib/control-ui-resource-counts.ts",
          "./lib/control-ui-talk-fixture.ts",
          "./lib/control-ui-long-session-probe.ts",
          "../ui/src/test-helpers/control-ui-team-scale-history-fixture.ts",
          "./lib/control-ui-chat-composer-scenarios.ts",
          "./lib/control-ui-chat-message-scenarios.ts",
          "./lib/control-ui-chat-panel-scenarios.ts",
          "./lib/control-ui-engine-action-scenarios.ts",
          "./lib/control-ui-engine-action-timing.ts",
          "./lib/control-ui-interaction-scenarios.ts",
          "./lib/control-ui-interaction-navigation.ts",
          "./lib/control-ui-engine-streaming-scenarios.ts",
          "./lib/control-ui-streaming-reply.ts",
          "./lib/control-ui-streaming-fixture.ts",
          "./lib/control-ui-streaming-statistics.ts",
          "./lib/control-ui-engine-memory.ts",
          "./lib/control-ui-engine-memory-scenarios.ts",
          "./lib/control-ui-engine-plugin-memory-scenarios.ts",
          "./lib/control-ui-engine-page-scenarios.ts",
          "./lib/control-ui-data-board-scenarios.ts",
          "./lib/control-ui-data-log-scenarios.ts",
          "./lib/control-ui-data-usage-scenarios.ts",
          "./lib/control-ui-page-observer.ts",
          "./lib/control-ui-bench-gateway-server.ts",
          "./lib/control-ui-bench-order.ts",
          "./lib/control-ui-engine-configurations.ts",
          "./lib/control-ui-engine-configuration-observer.ts",
        ].map(async (file) => [
          file,
          createHash("sha256")
            .update(await readFile(new URL(file, import.meta.url)))
            .digest("hex"),
        ]),
      ),
    ),
    browsers: Object.fromEntries(
      [...browsers].map(([engine, browser]) => [engine, browser.version()]),
    ),
    firefoxCapabilities: engines.includes("firefox")
      ? {
          applicationElapsed: true,
          cpuCounters: false,
          nativeTraces: false,
          heapSnapshots: false,
          mobile: "viewport and touch only; isMobile emulation unavailable",
          layoutInstability: "detected per observation; unsupported is null, not zero",
        }
      : undefined,
    bundles: servers.map(({ directory, build, sha256, workboardSource }) => ({
      directory,
      build,
      sha256,
      workboardSource,
    })),
    host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, load: os.loadavg() },
    pairs,
    viewports,
    networkProfiles,
    pageOrigin,
    configurations,
    trace: values.trace,
    observerOrigins: values["observer-origins"],
    cpuOnly: values["cpu-only"],
    cpuProfile: values["cpu-profile"],
    nativeAudit: values["native-audit"],
    idleWarmupOverrideMs: idleWarmupOverrideMs ?? null,
    idleDurationMs,
    allocations: values.allocations,
    mutationAudit: values["mutation-audit"],
    remountAudit: values["remount-audit"],
    routeTransitions: values["route-transitions"],
    transitionTargets: values["transition-targets"]?.split(","),
    routeTransitionCoverage: values["route-transitions"]
      ? engineRouteTransitionCoverage
      : undefined,
    cpuThrottle,
    memorySoakRounds,
    collection: values.allocations
      ? "V8 sampled allocations including major/minor-GC collected objects; diagnostic overhead, not timing proof"
      : values["remount-audit"]
        ? "DOM attachment census with synchronous removal snapshots; diagnostic overhead, not timing proof. DOM detach is not Solid disposal."
        : values["mutation-audit"]
          ? "MutationObserver over document/open shadow roots and formatter wrappers; diagnostic overhead, not timing proof. Pixel differences include caret/animation changes. Child-content identity is sampled at observer delivery."
          : values["native-audit"]
            ? "Chromium native timeline, V8 samples and LayerTree; diagnostic instrumentation, not timing proof"
            : values["cpu-profile"]
              ? "V8 sampled self-time census; diagnostic attribution, not timing proof"
              : values.trace
                ? "Playwright tracing and engine Inspector/Profiler; overhead included"
                : values["cpu-only"]
                  ? "WebKit smoothed utilization diagnostic (not action CPU) and Chromium CDP thread CPU; no timeline or script profiler"
                  : "Untraced wall and browser-local application time; Chromium CDP counters only, unavailable WebKit/Firefox counters are null",
    order:
      "Serial network profiles alternate each pair; engine/configuration/bundle positions rotate and reverse across pairs; fresh browser context per observation",
    acceptance:
      "Census screens >1.3x engine/Chromium; confirm with ten rotated pairs plus A/A. Fix proof: twenty rotated pairs plus A/A; median regression <=5% and p95 no worse. Missing CPU clocks cannot certify CPU wins on a noisy host; >20% attributable regression blocks.",
    frameCadence:
      "Prepare and settle frame intervals are consecutive requestAnimationFrame timestamp differences, not the full wait duration. scenarioMs includes driver input and scenario assertions; settleWaitMs measures the final two-frame wait. Their sum is wallMs. These are automation-to-assertion timings, not input-to-paint latency. Browser-local actionTiming splits the driver prefix, application elapsed to the last observed DOM commit (or native value edit), and the assertion/settle tail. These three sum to browserSpanMs, not Node wallMs. Focus work can occur in the prefix; compound input spans retain intermediate driver delays. Trace-only marks expose the same boundaries. Missing native input or an explicit Gateway-response mark, or a missing commit, makes action timing unavailable.",
    boundary:
      "Production bundle and HTTP owner; synthetic Gateway. Cold means fresh context; warm means same-context document reload. Mock routing disables HTTP cache in both engines. Nonlocal profiles add the configured delay to every HTTP request and every incoming mock Gateway frame (including the connect challenge); RPC replies thus include a simulated round trip, with no added throughput cap. Mobile transcript-top uses a native scrollport jump, not wheel input. No live Gateway/provider latency.",
    memoryContract:
      "Opt-in memory-* scenes retain one document, drain 4.1 s retirement timers, clear synthetic request history, then force two collections at each named checkpoint. Compare warm and late checkpoints; heap/native categories/RSS and DOM wrapper/native counts have different engine-specific meanings. Memory-scene elapsed times include forced GC and snapshots and are not latency evidence.",
    idleContract: `Idle CPU spans a Node-side ${idleDurationMs} ms wait. Hidden idle defaults to 60000 ms of warmup after native visibility settles; visible idle defaults to 0 ms. An explicit idle-warmup-ms overrides either default; 0 measures the initial transition, which can include background memory reclamation. Each idle scenario records its resolved warmup. Counter/request endpoints also include measurement instrumentation setup/draining; reveal and clock recovery occur afterward. Blank/static controls retain shared observation instrumentation without loading the app or Gateway.`,
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      route: scenario.route,
      expected: scenario.expected,
      navigation: scenario.navigation,
      memory: scenario.memory,
      diagnostic: scenario.diagnostic,
      viewports: scenario.viewports,
      ...(isEngineIdleScenario(scenario) ? { idleWarmupMs: resolveIdleWarmupMs(scenario) } : {}),
    })),
    ...(pageBenchmark
      ? { pageCoverage: enginePageCoverage, pageFixtureCounts: enginePageFixtureCounts }
      : {}),
  });
  for (const viewport of viewports) {
    for (const item of scenarios) {
      for (let pair = 0; pair < pairs; pair++) {
        const orderedEngines = controlUiBenchOrder(engines, pair);
        const slots = [...servers.entries()];
        const orderedProfiles = pair % 2 ? networkProfiles.toReversed() : networkProfiles;
        for (const { networkProfile, engine } of orderedProfiles.flatMap((selectedProfile) =>
          orderedEngines.map((selectedEngine) => ({
            networkProfile: selectedProfile,
            engine: selectedEngine,
          })),
        )) {
          const configuredSlots = controlUiBenchOrder(
            configurations.flatMap((configuration) =>
              slots.map(([bundle, slot]) => ({ configuration, bundle, slot })),
            ),
            pair,
          );
          for (const [position, { configuration, bundle, slot }] of configuredSlots.entries()) {
            slot.server.setAssetLatencyMs(networkProfile.httpLatencyMs);
            let scenario =
              createEngineBootScenarios(slot.server.baseUrl, networkProfile.gatewayLatencyMs).find(
                ({ id }) => id === item.id,
              ) ??
              createEngineCompletedRunScenarios(slot.server.baseUrl).find(
                ({ id }) => id === item.id,
              ) ??
              (item.id.startsWith("page-")
                ? createEnginePageScenarios(
                    networkProfile.gatewayLatencyMs,
                    pageOrigin,
                    slot.server.baseUrl,
                  ).find(({ id }) => id === item.id)
                : undefined) ??
              item;
            const idleControl = isEngineIdleControl(scenario);
            const idleWarmupMs = resolveIdleWarmupMs(scenario);
            const artifactPrefix = `${viewport.name}-${scenario.id}-${networkProfile.name}-${pair + 1}-${engine}-${bundle}-${configuration.name.replaceAll(":", "-")}`;
            const observation: Observation = {
              configuration: configuration.name,
              engine,
              networkProfile: networkProfile.name,
              viewport: viewport.name,
              step: scenario.id,
              bundle,
              pair,
              position,
              status: "failed",
              resizeErrorCount: 0,
              hostLoadAverage: os.loadavg(),
              artifactPrefix,
            };
            if (scenario.id.startsWith("remount-from-")) {
              observation.transitions = [];
              scenario = createEngineRouteTransitionScenarios(async (page, transition, run) => {
                const row: NonNullable<Observation["transitions"]>[number] = {
                  ...transition,
                  wallMs: 0,
                };
                const started = performance.now();
                if (values["remount-audit"]) {
                  await page.evaluate(() => {
                    window.openclawRemountAudit = window.openclawCreateRemountAudit!();
                    window.openclawRemountAudit.start();
                  });
                }
                const measurement = await startEngineMeasurement(page, engine, { trace: false });
                try {
                  row.applicationMs = await run();
                } catch (error) {
                  row.error = String(error);
                  await page.screenshot({
                    path: path.join(
                      artifactDir,
                      `${artifactPrefix}.transition-${observation.transitions!.length}-failed.png`,
                    ),
                  });
                } finally {
                  row.wallMs = performance.now() - started;
                  row.metrics = (await measurement.stop()).metrics;
                  if (values["remount-audit"]) {
                    row.remounts = await page.evaluate(() => window.openclawRemountAudit!.finish());
                  }
                  observation.transitions!.push(row);
                  await writeJson(`${artifactPrefix}.transitions.json`, observation.transitions);
                }
              }, values["transition-targets"]?.split(",")).find(({ id }) => id === scenario.id)!;
            }
            if (scenario.viewports && !scenario.viewports.some((name) => name === viewport.name)) {
              observation.status = "skipped";
              observation.skipReason = "This control is unavailable at this viewport.";
              observations.push(observation);
              await observationWriter.record(observation);
              continue;
            }
            if (scenario.visibility === "hidden" && engine !== "chromium") {
              observation.status = "skipped";
              observation.skipReason = `${engine} has no supported native headless hiding API; no simulated visibility proof.`;
              observations.push(observation);
              await observationWriter.record(observation);
              continue;
            }
            if (scenario.memory || !browsers.get(engine)!.isConnected()) {
              await browsers.get(engine)!.close();
              browsers.set(engine, await launchEngine(engine));
            }
            // Use the existing runner-owned full Chrome helper for both idle states.
            // Normal Playwright contexts force visibility even after minimization.
            const nativeBrowser =
              (isEngineIdleScenario(scenario) || scenario.visibility === "hidden") &&
              engine === "chromium"
                ? await launchTalkObservationBrowser(artifactDir, false)
                : undefined;
            const observationBrowser = nativeBrowser?.browser ?? browsers.get(engine)!;
            const context =
              nativeBrowser?.context ??
              (await observationBrowser.newContext({
                viewport: { width: viewport.width, height: viewport.height },
                // Firefox supports the narrow viewport and touch, but not isMobile emulation.
                ...(engine === "firefox" ? {} : { isMobile: viewport.name === "mobile" }),
                hasTouch: viewport.name === "mobile",
                serviceWorkers: "block",
                colorScheme: configuration.colorScheme,
                locale: configuration.locale,
                deviceScaleFactor: configuration.deviceScaleFactor,
                reducedMotion: configuration.reducedMotion,
                forcedColors: configuration.forcedColors,
              }));
            const page = await context.newPage();
            page.setDefaultTimeout(scenario.id.startsWith("chat-actions-") ? 15_000 : 30_000);
            const traceAction = (values.trace || values["native-audit"]) && !scenario.navigation;
            const errors: Array<{ message: string; phase: string }> = [];
            let phase = "setup";
            page.on("pageerror", (error: Error) => {
              errors.push({ message: error.message, phase });
              if (error.message.includes("ResizeObserver loop")) {
                observation.resizeErrorCount++;
              }
            });
            let tracingStarted = false;
            let measurement: Awaited<ReturnType<typeof startEngineMeasurement>> | undefined;
            let cpuProfile: ColdLoadCpuProfile | undefined;
            let layerAudit: Awaited<ReturnType<typeof createControlUiLayerAudit>> | undefined;
            let memory: Awaited<ReturnType<typeof createEngineMemoryCollector>> | undefined;
            let throttle: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
            let minimizedWindow: number | undefined;
            let idleRequests: Array<{ method: string }> | undefined;
            try {
              if (nativeBrowser) {
                await page.setViewportSize(viewport);
                await page.emulateMedia({
                  colorScheme: configuration.colorScheme,
                  reducedMotion: configuration.reducedMotion,
                  forcedColors: configuration.forcedColors,
                });
                throttle = await context.newCDPSession(page);
                await throttle.send("Emulation.setDeviceMetricsOverride", {
                  width: viewport.width,
                  height: viewport.height,
                  deviceScaleFactor: configuration.deviceScaleFactor,
                  mobile: viewport.name === "mobile",
                });
                if (viewport.name === "mobile") {
                  await throttle.send("Emulation.setTouchEmulationEnabled", { enabled: true });
                }
                await throttle.send("Emulation.setLocaleOverride", {
                  locale: configuration.locale,
                });
                await throttle.send("Network.setUserAgentOverride", {
                  userAgent: await page.evaluate(() => navigator.userAgent),
                  acceptLanguage: configuration.locale,
                });
              }
              if (cpuThrottle !== 1) {
                throttle ??= await context.newCDPSession(page);
                await throttle.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
              }
              await page.addInitScript("globalThis.__name = (fn) => fn");
              if (values["remount-audit"]) {
                await page.addInitScript(
                  `window.openclawCreateRemountAudit = ${createControlUiRemountAudit.toString()};${scenario.navigation ? "window.openclawRemountAudit = window.openclawCreateRemountAudit(); window.openclawRemountAudit.start();" : ""}`,
                );
              }
              if (values["mutation-audit"]) {
                await page.addInitScript(
                  `window.openclawMutationAudit = (${createControlUiMutationAudit.toString()})();${scenario.navigation ? "window.openclawMutationAudit.start();" : ""}`,
                );
              }
              await installControlUiPageObserver(page);
              await installEngineConfigurationObserver(
                page,
                configuration,
                !scenario.standaloneDocument,
              );
              await page.addInitScript(installInteractionNavigationPreloadObserver);
              if (scenario.memory || isEngineIdleScenario(scenario)) {
                await page.addInitScript(installControlUiResourceCounts);
              }
              await page.addInitScript(() => performance.setResourceTimingBufferSize(2048));
              if (values.trace || values["observer-origins"]) {
                await page.addInitScript(() => {
                  const deliveries: unknown[] = [];
                  const resizeErrors: unknown[] = [];
                  Reflect.set(window, "__engineResizeErrors", resizeErrors);
                  const NativeObserver = ResizeObserver;
                  window.ResizeObserver = class extends NativeObserver {
                    constructor(callback: ResizeObserverCallback) {
                      const origin = new Error().stack;
                      super((entries, observer) => {
                        deliveries.push({
                          at: performance.now(),
                          origin,
                          targets: entries.map(
                            ({ target }) => `${target.tagName}.${target.className}`,
                          ),
                        });
                        if (deliveries.length > 20) {
                          deliveries.shift();
                        }
                        callback(entries, observer);
                      });
                    }
                  };
                  window.addEventListener("error", (event) => {
                    if (event.message.includes("ResizeObserver loop")) {
                      resizeErrors.push({ at: performance.now(), deliveries: [...deliveries] });
                    }
                  });
                });
              }
              if (!idleControl) {
                await page.addInitScript(
                  ({ key, gatewayUrl, settings }) => {
                    if (window === window.top) {
                      localStorage.setItem(
                        key,
                        JSON.stringify({ ...settings, gatewayUrl, lobsterPetVisits: false }),
                      );
                      localStorage.setItem("openclaw.i18n.locale", settings.locale);
                    }
                  },
                  {
                    key: controlUiBundledSettingsStorageKey(slot.server.baseUrl),
                    gatewayUrl: controlUiBundledGatewayUrl(slot.server.baseUrl),
                    settings: {
                      ...scenario.settings,
                      theme: configuration.theme,
                      themeMode: configuration.themeMode,
                      locale: configuration.locale,
                    },
                  },
                );
              }
              let fixture: ReturnType<typeof createScenarioFixture> = scenario.fixture
                ?.workboardResources
                ? createWorkboardResourceFixture(
                    slot.build.buildId,
                    slot.build.version,
                    slot.workboardSource!.root,
                  )
                : createScenarioFixture(slot.build.buildId, slot.build.version, scenario);
              if (scenario.fixture?.workboardResources && scenario.id.startsWith("remount-from-")) {
                const broad = createScenarioFixture(
                  slot.build.buildId,
                  slot.build.version,
                  scenario,
                );
                fixture = {
                  ...broad,
                  nativePlugins: fixture.nativePlugins,
                  controlUiTabs: fixture.controlUiTabs,
                  sessions: [
                    ...new Map(
                      [...broad.sessions, ...fixture.sessions].map((row) => [row.key, row]),
                    ).values(),
                  ],
                  featureMethods: [
                    ...new Set([
                      ...(broad.featureMethods ?? []),
                      ...(fixture.featureMethods ?? []),
                    ]),
                  ],
                  methodResponses: {
                    ...broad.methodResponses,
                    ...fixture.methodResponses,
                    "plugins.uiDescriptors": Object.assign(
                      {},
                      broad.methodResponses?.["plugins.uiDescriptors"],
                      { controlUiTabs: fixture.controlUiTabs },
                    ),
                  },
                };
              }
              const configResponse = fixture.methodResponses?.["config.get"];
              if (isRecord(configResponse) && isRecord(configResponse.config)) {
                const config = configResponse.config;
                const ui = isRecord(config.ui) ? config.ui : {};
                const prefs = isRecord(ui.prefs) ? ui.prefs : {};
                config.ui = {
                  ...ui,
                  prefs: {
                    ...prefs,
                    theme: configuration.theme,
                    themeMode: configuration.themeMode,
                    locale: configuration.locale,
                  },
                };
                configResponse.sourceConfig = config;
                configResponse.raw = JSON.stringify(config);
              }
              // Keep document and mocked bootstrap capabilities identical;
              // the app correctly reloads when these disagree.
              slot.server.setTerminalEnabled(fixture.terminalEnabled ?? false);
              const sessions = createTeamScaleSidebarListOwner({
                rows: fixture.sessions,
                viewerProfileId: "interaction-viewer",
                now: 1_800_000_000_000,
                defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
                owners: [],
              });
              const defaults = {
                "sessions.list": (params: unknown) => {
                  if (!isRecord(params)) {
                    throw new Error("Expected sessions.list parameters");
                  }
                  return sessions.list(params).result;
                },
              };
              const gateway = idleControl
                ? undefined
                : await installNativePluginMockGateway(
                    page,
                    { ...fixture, awaitInitialRoster: false },
                    {
                      nativeAssetLatencyMs: networkProfile.httpLatencyMs,
                      requestHandlers: {
                        ...defaults,
                        ...scenario.createRequestHandlers?.(defaults),
                      },
                      afterInitScript: `${scenario.initScript ?? ""}\n//# sourceURL=openclaw-bench://test-helpers/mock-gateway.js\n`,
                    },
                  );
              if (networkProfile.httpLatencyMs) {
                // The mock fulfills bootstrap configuration before it reaches the HTTP owner.
                await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
                  await new Promise((resolve) => {
                    setTimeout(resolve, networkProfile.httpLatencyMs);
                  });
                  await route.fallback();
                });
              }
              await scenario.setup?.(page);
              if (scenario.navigation !== "measured") {
                await page.goto(new URL(scenario.route, slot.server.baseUrl).href);
                if (!scenario.standaloneDocument) {
                  await waitForControlUiInitialRoster(page, 30_000);
                  await page.waitForFunction(
                    (locale) => document.documentElement.lang === locale,
                    configuration.locale,
                  );
                }
              }
              if (isEngineIdleControl(scenario)) {
                await scenario.prepare(page);
              } else {
                await scenario.prepare(page, gateway!);
              }
              if (scenario.navigation !== "measured") {
                if (!scenario.standaloneDocument) {
                  observation.navigationPreloads = await settleInteractionNavigationPreloads(page);
                }
                await page.waitForLoadState("networkidle");
                await page.evaluate(() => document.fonts.ready.then(() => undefined));
                observation.prepareFrameIntervalMs = await frames(page);
              }
              let before = (await gateway?.getRequests())?.length ?? 0;
              if (values.trace) {
                // DOM snapshots execute injected script on each action and distort the profile.
                await context.tracing.start({
                  screenshots: false,
                  snapshots: false,
                  sources: true,
                });
                tracingStarted = true;
              }
              if (!scenario.navigation) {
                await resetControlUiPageObserver(page);
              }
              if (scenario.id.startsWith("chat-actions-")) {
                await installChatActionObservation(
                  page,
                  values.trace,
                  scenario.id === "chat-actions-fork" ||
                    scenario.id.startsWith("chat-actions-split-"),
                );
              }
              const actionTiming =
                !scenario.navigation &&
                !scenario.memory &&
                !isEngineIdleScenario(scenario) &&
                scenario.visibility !== "hidden"
                  ? await page.evaluateHandle(createEngineActionTiming, traceAction)
                  : undefined;
              const beforePixels = values["mutation-audit"]
                ? await page.screenshot({
                    path: path.join(artifactDir, `${artifactPrefix}.before.png`),
                  })
                : undefined;
              if (values["mutation-audit"] && !scenario.navigation) {
                await page.evaluate(() => window.openclawMutationAudit!.start());
              }
              if (
                values["remount-audit"] &&
                !scenario.navigation &&
                !scenario.id.startsWith("remount-from-")
              ) {
                await page.evaluate(() => {
                  window.openclawRemountAudit = window.openclawCreateRemountAudit!();
                  window.openclawRemountAudit.start();
                });
              }
              if (values["native-audit"]) {
                layerAudit = await createControlUiLayerAudit(page);
              }
              if (scenario.visibility === "hidden") {
                const visibility = await context.newCDPSession(page);
                try {
                  const { windowId } = await visibility.send("Browser.getWindowForTarget");
                  minimizedWindow = windowId;
                  await visibility.send("Browser.setWindowBounds", {
                    windowId,
                    bounds: { windowState: "minimized" },
                  });
                  await page.waitForFunction(
                    () => document.visibilityState === "hidden",
                    undefined,
                    { polling: 50, timeout: 5_000 },
                  );
                } finally {
                  await visibility.detach();
                }
              }
              if (isEngineIdleScenario(scenario) && idleWarmupMs > 0) {
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, idleWarmupMs);
                });
              }
              // Hide first so minimizing does not become part of hidden-idle paint counts.
              // Creation above obtains the compositor inventory while a surface is visible.
              await layerAudit?.capture();
              if (isEngineIdleScenario(scenario)) {
                const idleBefore = await readEngineIdleState(page);
                if (
                  idleBefore.document.visibility !== (scenario.visibility ?? "visible") ||
                  (!idleControl && idleBefore.document.gatewayPhase !== "connected")
                ) {
                  throw new Error(
                    "Idle requires the requested native visibility and a connected Gateway",
                  );
                }
                observation.idle = {
                  warmupMs: idleWarmupMs,
                  before: idleBefore,
                  fixture: {
                    sessions: idleControl ? 0 : fixture.sessions.length,
                    transcriptMessages: Object.values(
                      idleControl ? {} : (fixture.sessionTranscripts ?? {}),
                    ).reduce((total, transcript) => total + transcript.messages.length, 0),
                  },
                };
                before = (await gateway?.getRequests())?.length ?? 0;
              }
              measurement = await startEngineMeasurement(page, engine, {
                trace: values.trace,
                cpuOnly: values["cpu-only"],
                cpuProfile: values["cpu-profile"],
                nativeAudit: values["native-audit"],
                allocations: values.allocations,
              });
              phase = "measurement";
              const start = performance.now();
              if (scenario.memory) {
                memory = await createEngineMemoryCollector(page, engine);
                observation.memory = [];
              }
              const timeOrigin = actionTiming
                ? await actionTiming.evaluate((timing) => timing.start())
                : isEngineIdleScenario(scenario)
                  ? 0
                  : await page.evaluate(() => performance.timeOrigin);
              if (memory) {
                // Bind checkpoints to this document, independently of wall-clock adjustments.
                await page.evaluate((identity) => {
                  Reflect.set(window, "openclawMemoryDocumentIdentity", identity);
                }, artifactPrefix);
              }
              observation.evidence =
                (isEngineIdleControl(scenario)
                  ? await scenario.run()
                  : await scenario.run(
                      page,
                      gateway!,
                      memory
                        ? async (checkpoint) => {
                            // MCP retirement and reconnect feedback own intentional timers up to 4 s.
                            await page.waitForTimeout(4_100);
                            await frames(page);
                            const checkpointState = await page.evaluate(
                              ({ identity, timeOrigin: initialTimeOrigin }) => {
                                if (
                                  Reflect.get(window, "openclawMemoryDocumentIdentity") !== identity
                                ) {
                                  throw new Error("Memory workload reloaded the document");
                                }
                                const requests = (window as MockGatewayWindow)
                                  .openclawControlUiE2eGateway!.requests;
                                const clearedFixtureRequests = requests.length;
                                requests.length = 0;
                                return {
                                  timeOrigin: {
                                    initial: initialTimeOrigin,
                                    current: performance.timeOrigin,
                                  },
                                  clearedFixtureRequests,
                                  resources: Reflect.get(window, "openclawResourceCounts")(),
                                };
                              },
                              { identity: artifactPrefix, timeOrigin },
                            );
                            const metrics = await memory!.capture(
                              path.join(
                                artifactDir,
                                `${artifactPrefix}-${checkpoint}.heapsnapshot`,
                              ),
                            );
                            observation.memory!.push({
                              checkpoint,
                              ...checkpointState,
                              metrics,
                              process: processMemory(observationBrowser),
                            });
                            await writeJson(`${artifactPrefix}-memory.json`, observation.memory);
                          }
                        : undefined,
                    )) ?? undefined;
              if (actionTiming) {
                await actionTiming.evaluate((timing) => timing.endScenario());
              }
              if (scenario.id.startsWith("chat-actions-")) {
                observation.evidence = {
                  ...observation.evidence,
                  ...(await readChatActionObservation(page)),
                };
              }
              observation.scenarioMs = performance.now() - start;
              if (!isEngineIdleScenario(scenario) && scenario.visibility !== "hidden") {
                observation.settleFrameIntervalMs = await frames(page);
              }
              observation.wallMs = performance.now() - start;
              observation.settleWaitMs = observation.wallMs - observation.scenarioMs;
              if (actionTiming) {
                observation.actionTiming = await actionTiming.evaluate((timing) => timing.finish());
                await actionTiming.dispose();
              }
              const activeMeasurement = measurement;
              measurement = undefined;
              const captured = await activeMeasurement.stop();
              observation.metrics = captured.metrics;
              if (captured.allocations) {
                const mapped = await mapControlUiAllocationProfile(captured.allocations, {
                  assetBaseUrl: `${slot.server.baseUrl}/assets/`,
                  assetDirectory: path.join(slot.directory, "assets"),
                });
                await writeJson(`${artifactPrefix}.heapprofile`, mapped.profile);
                observation.allocations = {
                  ...summarizeControlUiAllocations(mapped.profile),
                  mappedFrames: mapped.mappedFrames,
                  unmappedFrames: mapped.unmappedFrames,
                };
              }
              if (observation.idle) {
                observation.idle.after = await readEngineIdleState(page);
                idleRequests = ((await gateway?.getRequests()) ?? []).slice(before);
                const { before: idleBefore, after } = observation.idle;
                if (
                  after.document.visibility !== idleBefore.document.visibility ||
                  (!idleControl && after.document.gatewayPhase !== "connected") ||
                  after.document.route !== idleBefore.document.route
                ) {
                  throw new Error("Idle changed route, Gateway connection, or native visibility");
                }
                const factor = 60_000 / observation.wallMs;
                observation.idle.taskMsPerMinute =
                  captured.metrics.taskMs === null ? null : captured.metrics.taskMs * factor;
                observation.idle.scriptMsPerMinute =
                  captured.metrics.scriptMs === null ? null : captured.metrics.scriptMs * factor;
                // Counter endpoints include profiler draining; do not divide them by CPU's window.
                observation.idle.resourceIntervalMs =
                  after.document.atMs - idleBefore.document.atMs;
              }
              if (values["mutation-audit"]) {
                observation.mutations = await page.evaluate(() =>
                  window.openclawMutationAudit!.finish(),
                );
                const afterPixels = await page.screenshot({
                  path: path.join(artifactDir, `${artifactPrefix}.after.png`),
                });
                observation.pixels = await page.evaluate(compareControlUiScreenshots, {
                  before: beforePixels!.toString("base64"),
                  after: afterPixels.toString("base64"),
                });
              }
              if (values["remount-audit"] && !scenario.id.startsWith("remount-from-")) {
                observation.remounts = await page.evaluate(() =>
                  window.openclawRemountAudit!.finish(),
                );
              }
              if (scenario.navigation) {
                await page.waitForLoadState("networkidle");
                await page.evaluate(() => document.fonts.ready.then(() => undefined));
              }
              await finishControlUiPageObserver(page);
              observation.configurationEvidence = await readEngineConfigurationObservation(
                page,
                configuration,
                !scenario.standaloneDocument,
              );
              observation.pageMetrics = await readControlUiPageObserver(
                page,
                observation.actionTiming?.startMs,
                typeof observation.evidence?.visitReadyAtMs === "number"
                  ? observation.evidence.visitReadyAtMs
                  : undefined,
                typeof observation.evidence?.visitStartedAtMs === "number"
                  ? observation.evidence.visitStartedAtMs
                  : undefined,
              );
              if (values["native-audit"]) {
                observation.layers = await layerAudit!.finish();
                if (observation.idle) {
                  observation.idle.layerIntervalMs =
                    Date.parse(observation.layers.after.capturedAt) -
                    Date.parse(observation.layers.before.capturedAt);
                }
                await writeJson(`${artifactPrefix}.native.json`, captured);
                observation.native = summarizeControlUiNativeTrace(
                  captured.timeline ?? [],
                  captured.profile,
                );
              }
              if (minimizedWindow !== undefined) {
                const visibility = await context.newCDPSession(page);
                try {
                  await visibility.send("Browser.setWindowBounds", {
                    windowId: minimizedWindow,
                    bounds: { windowState: "normal" },
                  });
                  await page.waitForFunction(() => document.visibilityState === "visible");
                  await frames(page);
                  if (observation.idle) {
                    observation.idle.revealed = await readEngineIdleState(page);
                  }
                } finally {
                  await visibility.detach();
                }
              }
              if (values["native-audit"] || scenario.id === "theme-switch-cycles") {
                observation.computedTheme = await page.evaluate(() => {
                  const styles = getComputedStyle(document.documentElement);
                  return Object.fromEntries(
                    Array.from(styles)
                      .filter((name) => name.startsWith("--"))
                      .map((name) => [name, styles.getPropertyValue(name).trim()]),
                  );
                });
              }
              if (scenario.id.startsWith("idle-sidebar-clock-") && observation.idle) {
                if (pair === 0) {
                  await page.screenshot({
                    path: path.join(artifactDir, `${artifactPrefix}.before-scroll.png`),
                  });
                }
                observation.idle.clockRecovery = await verifyEngineIdleClocks(page, gateway!);
              }
              if (scenario.id === "sidebar-running-clock-scroll-resize") {
                observation.evidence = {
                  ...observation.evidence,
                  clockRecoveryChecks: (await verifyEngineIdleClocks(page, gateway!)).length,
                };
              }
              if (values["cpu-profile"]) {
                // SAFETY: This mode is Chromium-only; Profiler.stop returns V8's
                // Profile shape, whose sample intervals the census validates.
                const mapped = await mapColdLoadCpuProfile(captured.profile as ColdLoadCpuProfile, {
                  assetBaseUrl: `${slot.server.baseUrl}/assets/`,
                  assetDirectory: path.join(slot.directory, "assets"),
                });
                await writeJson(`${artifactPrefix}.cpuprofile`, mapped.profile);
                cpuProfile = mapped.profile;
              }
              if (traceAction) {
                await writeJson(
                  `${artifactPrefix}.user-timing.json`,
                  await page.evaluate(() =>
                    performance
                      .getEntriesByType("mark")
                      .filter(({ name }) => name.startsWith("engine:"))
                      .map(({ name, startTime }) => ({ name, startTime })),
                  ),
                );
              }
              if (scenario.id.startsWith("page-")) {
                observation.evidence = {
                  ...observation.evidence,
                  ...(await collectEnginePageStructure(page)),
                };
              }
              if (values.trace || values["cpu-only"]) {
                await writeJson(`${artifactPrefix}.inspector.json`, captured);
              }
              observation.requests = {};
              for (const { method } of idleRequests ??
                ((await gateway?.getRequests()) ?? []).slice(
                  scenario.navigation || scenario.memory ? 0 : before,
                )) {
                observation.requests[method] = (observation.requests[method] ?? 0) + 1;
              }
              if (errors.length) {
                throw new Error(errors.map(({ message }) => message).join("\n"));
              }
              const failedTransitions = observation.transitions?.filter((row) => row.error);
              if (failedTransitions?.length) {
                throw new Error(
                  `${failedTransitions.length} transition(s) failed; see transitions.json`,
                );
              }
              if (
                configuration.forcedColors === "active" &&
                !observation.configurationEvidence.forcedColors
              ) {
                observation.status = "skipped";
                observation.skipReason = "This engine does not emulate forced colors.";
              } else {
                observation.status = "passed";
              }
            } catch (error) {
              observation.error = String(error);
            } finally {
              phase = "capture";
              observation.errorEvents = errors;
              try {
                await layerAudit?.dispose();
                await memory?.dispose();
                if (values.trace || values["observer-origins"]) {
                  const resizeErrors: unknown[] = await page.evaluate(() =>
                    Reflect.get(window, "__engineResizeErrors"),
                  );
                  await writeJson(`${artifactPrefix}.resize-errors.json`, resizeErrors);
                }
                if (measurement) {
                  await writeJson(
                    `${artifactPrefix}.interrupted-inspector.json`,
                    await measurement.stop(),
                  );
                }
                if (scenario.id.startsWith("streaming-")) {
                  const streaming = await page.evaluate(() =>
                    Reflect.get(window, "__engineStreamingResult"),
                  );
                  if (streaming) {
                    await writeJson(`${artifactPrefix}.streaming.json`, streaming);
                  }
                }
                if (pair === 0 || observation.status === "failed") {
                  await page.screenshot({ path: path.join(artifactDir, `${artifactPrefix}.png`) });
                }
                if (scenario.id.startsWith("chat-actions-") && observation.status === "failed") {
                  await writeFile(
                    path.join(artifactDir, `${artifactPrefix}.failure.html`),
                    await page.content(),
                  );
                }
                if (tracingStarted) {
                  await context.tracing.stop({
                    path: path.join(artifactDir, `${artifactPrefix}.trace.zip`),
                  });
                }
              } catch (error) {
                observation.error = [observation.error, String(error)].filter(Boolean).join("\n");
                observation.status = "failed";
              }
              try {
                await throttle?.detach();
                await context.close();
                if (scenario.memory) {
                  observation.retiredProcess = processMemory(observationBrowser);
                }
              } finally {
                await nativeBrowser?.close();
                if (scenario.memory) {
                  await observationBrowser.close();
                }
              }
              if (errors.length) {
                observation.status = "failed";
                observation.error ??= errors.map(({ message }) => message).join("\n");
              }
              // Capture/cleanup can also fail after the scenario assertions pass.
              if (observation.status === "passed" && cpuProfile) {
                cpuCensus.add(
                  `${viewport.name}/${scenario.id}/${configuration.name}/bundle-${bundle}`,
                  cpuProfile,
                );
                await writeJson("cpu-census.json", cpuCensus.report());
              }
              observations.push(observation);
              await observationWriter.record(observation);
              console.log(
                JSON.stringify(
                  observation.memory
                    ? { ...observation, memory: observation.memory.length }
                    : observation,
                ),
              );
            }
          }
        }
      }
    }
  }
} finally {
  try {
    for (const browser of browsers.values()) {
      await browser.close();
    }
    for (const { server } of servers) {
      await server.close();
    }
  } finally {
    await observationWriter.finish(observations);
  }
}
function distribution(samples: number[]) {
  if (!samples.length) {
    return null;
  }
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}
const cells = new Map<
  string,
  Pick<Observation, "viewport" | "step" | "engine" | "bundle" | "networkProfile" | "configuration">
>();
for (const {
  viewport,
  step,
  engine,
  bundle,
  networkProfile,
  configuration,
  memory,
} of observations) {
  if (memory) {
    continue;
  }
  cells.set(JSON.stringify([viewport, step, engine, bundle, networkProfile, configuration]), {
    viewport,
    step,
    engine,
    bundle,
    networkProfile,
    configuration,
  });
}
const summary = [...cells.values()].map((cell) => {
  const rows = observations.filter(
    (row) =>
      row.viewport === cell.viewport &&
      row.step === cell.step &&
      row.engine === cell.engine &&
      row.bundle === cell.bundle &&
      row.networkProfile === cell.networkProfile &&
      row.configuration === cell.configuration,
  );
  const passing = rows.filter((row) => row.status === "passed");
  // Keep completed intervals with browser errors visible; dropping them biases a buggy base.
  const measured = rows.filter((row) => row.wallMs !== undefined);
  const pageRows = measured.flatMap((row) => row.pageMetrics ?? []);
  const longestTasks = pageRows.flatMap((row) => row.longestLongTaskMs ?? []);
  const shifts = pageRows.flatMap((row) => row.cls ?? []);
  return {
    configuration: cell.configuration,
    viewport: cell.viewport,
    step: cell.step,
    engine: cell.engine,
    bundle: cell.bundle,
    networkProfile: cell.networkProfile,
    passed: passing.length,
    failed: rows.filter((row) => row.status === "failed").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    measured: measured.length,
    observerSupport: {
      layoutShifts: pageRows.filter((row) => row.layoutShiftsSupported).length,
      longTasks: pageRows.filter((row) => row.longTasksSupported).length,
      observations: pageRows.length,
    },
    resizeErrorCount: rows.reduce((total, row) => total + row.resizeErrorCount, 0),
    resizeErrorObservations: rows.filter((row) => row.resizeErrorCount > 0).length,
    targets: cell.step.startsWith("page-")
      ? {
          longTaskLimitMs: 50 * cpuThrottle,
          longTaskMet: longestTasks.length
            ? longestTasks.every((value) => value <= 50 * cpuThrottle)
            : null,
          clsMet: shifts.length ? shifts.every((value) => value === 0) : null,
        }
      : undefined,
    wallMs: distribution(measured.map((row) => row.wallMs!)),
    scenarioMs: distribution(measured.flatMap((row) => row.scenarioMs ?? [])),
    settleWaitMs: distribution(measured.flatMap((row) => row.settleWaitMs ?? [])),
    configurationReadyMs: distribution(
      measured.flatMap((row) => {
        const ready = row.evidence?.readyMs;
        return typeof ready === "number" && row.configurationEvidence
          ? [Math.max(ready, row.configurationEvidence.appliedMs)]
          : [];
      }),
    ),
    actionTiming: Object.fromEntries(
      (
        [
          "driverMs",
          "applicationMs",
          "settleMs",
          "assertionTailMs",
          "browserSpanMs",
          "inputCount",
          "mutationCount",
        ] as const
      ).map((key) => [key, distribution(measured.flatMap((row) => row.actionTiming?.[key] ?? []))]),
    ),
    prepareFrameIntervalMs: distribution(rows.flatMap((row) => row.prepareFrameIntervalMs ?? [])),
    settleFrameIntervalMs: distribution(rows.flatMap((row) => row.settleFrameIntervalMs ?? [])),
    evidence: Object.fromEntries(
      [...new Set(measured.flatMap((row) => Object.keys(row.evidence ?? {})))].map((key) => [
        key,
        distribution(
          measured.flatMap((row) => {
            const value = row.evidence?.[key];
            return typeof value === "number" ? [value] : [];
          }),
        ),
      ]),
    ),
    sampledCpuCoverageMs: distribution(
      measured.flatMap((row) => row.metrics?.sampledCpu?.coveredMs ?? []),
    ),
    metrics: Object.fromEntries(
      (
        ["scriptMs", "taskMs", "layoutMs", "styleMs", "cpuMs", "layoutCount", "styleCount"] as const
      ).map((metric) => [
        metric,
        distribution(
          measured.flatMap((row) => {
            const value = row.metrics?.[metric];
            return typeof value === "number" ? [value] : [];
          }),
        ),
      ]),
    ),
    pageMetrics: Object.fromEntries(
      (
        [
          "longestLongTaskMs",
          "longTaskTotalMs",
          "longTaskCount",
          "cls",
          "allShiftSum",
          "elementsBefore",
          "elementsAfter",
          "assetRequests",
          "assetRequestsCompletedByReady",
          "assetEncodedBytesCompletedByReady",
          "http1AssetConnectionWavesByReady",
        ] as const
      ).map((metric) => [
        metric,
        distribution(
          measured.flatMap((row) => {
            const value = row.pageMetrics?.[metric];
            return typeof value === "number" ? [value] : [];
          }),
        ),
      ]),
    ),
  };
});
const rows = summary
  .filter(({ engine }) => engine === "chromium")
  .flatMap((chromium) =>
    engines
      .filter((engine) => engine !== "chromium")
      .map((engine) => {
        const compared = summary.find(
          (row) =>
            row.engine === engine &&
            row.step === chromium.step &&
            row.viewport === chromium.viewport &&
            row.bundle === chromium.bundle &&
            row.networkProfile === chromium.networkProfile &&
            row.configuration === chromium.configuration,
        );
        const application = chromium.actionTiming.applicationMs;
        const comparedApplication = compared?.actionTiming.applicationMs;
        const driver = chromium.actionTiming.driverMs;
        const comparedDriver = compared?.actionTiming.driverMs;
        const ratio =
          application && comparedApplication && application.median > 0
            ? comparedApplication.median / application.median
            : null;
        const driverRatio =
          driver && comparedDriver && driver.median > 0
            ? comparedDriver.median / driver.median
            : null;
        const wallRatio =
          chromium.wallMs && compared?.wallMs
            ? compared.wallMs.median / chromium.wallMs.median
            : null;
        const chromiumReady =
          chromium.evidence.visitReadyMs ??
          chromium.evidence.leaveReadyMs ??
          chromium.evidence.readyMs;
        const comparedReady =
          compared?.evidence.visitReadyMs ??
          compared?.evidence.leaveReadyMs ??
          compared?.evidence.readyMs;
        const routeReadyRatio =
          chromiumReady && comparedReady && chromiumReady.median > 0
            ? comparedReady.median / chromiumReady.median
            : null;
        return {
          engine,
          chromium,
          compared,
          ratio,
          driverRatio,
          wallRatio,
          chromiumReady,
          comparedReady,
          routeReadyRatio,
        };
      }),
  )
  .toSorted((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
await writeJson("summary.json", {
  headlineMetric: "applicationMs",
  configurations,
  configurationComparisons: summary
    .filter((row) => row.configuration !== "default")
    .map((row) => {
      const baseline = summary.find(
        (candidate) =>
          candidate.configuration === "default" &&
          candidate.engine === row.engine &&
          candidate.viewport === row.viewport &&
          candidate.step === row.step &&
          candidate.bundle === row.bundle &&
          candidate.networkProfile === row.networkProfile,
      );
      const metric = row.step.endsWith("boot") ? "configurationReadyMs" : "applicationMs";
      const sample =
        metric === "configurationReadyMs"
          ? row.configurationReadyMs
          : row.actionTiming.applicationMs;
      const control =
        metric === "configurationReadyMs"
          ? baseline?.configurationReadyMs
          : baseline?.actionTiming.applicationMs;
      return {
        configuration: row.configuration,
        engine: row.engine,
        viewport: row.viewport,
        step: row.step,
        bundle: row.bundle,
        networkProfile: row.networkProfile,
        metric,
        medianRatio:
          sample && control && control.median > 0 ? sample.median / control.median : null,
        p95Ratio: sample && control && control.p95 > 0 ? sample.p95 / control.p95 : null,
      };
    }),
  comparisons: rows.map(({ engine, chromium, ratio, driverRatio, wallRatio, routeReadyRatio }) => ({
    engine,
    configuration: chromium.configuration,
    viewport: chromium.viewport,
    step: chromium.step,
    bundle: chromium.bundle,
    networkProfile: chromium.networkProfile,
    applicationRatio: ratio,
    driverRatio,
    wallRatio,
    routeReadyRatio,
  })),
  planned,
  executed: observations.length,
  failed: observations.filter((row) => row.status === "failed").length,
  skipped:
    observations.filter((row) => row.status === "skipped").length + planned - observations.length,
  ...(pageBenchmark ? { pageCoverage: enginePageCoverage } : {}),
  passed: observations.filter((row) => row.status === "passed").length,
  summary,
  memory: observations.flatMap((row) =>
    (row.memory ?? []).map((checkpoint) =>
      Object.assign(
        {
          configuration: row.configuration,
          engine: row.engine,
          viewport: row.viewport,
          step: row.step,
          bundle: row.bundle,
          pair: row.pair,
          networkProfile: row.networkProfile,
          status: row.status,
        },
        checkpoint,
      ),
    ),
  ),
});
await writeFile(
  path.join(artifactDir, "report.md"),
  [
    "# Control UI engine comparison",
    "",
    `Synthetic Gateway; production HTTP/bundle. ${values.trace ? "Traced samples include profiler overhead." : values["cpu-only"] ? "Sampled WebKit process CPU; Chromium main-thread CPU. No timeline or script profiler." : "Untraced wall samples; WebKit/Firefox native counters are unavailable (null)."} Wall time includes automation and assertions, not INP. WebKit Inspector script/layout/style durations are wall time; Chromium CDP uses thread CPU. Do not compare these as CPU ratios. Cold contexts are fresh; warm reload retains IndexedDB but mock routing disables HTTP cache.`,
    "",
    `Completed ${observations.length}/${planned} observations; ${observations.filter(({ status }) => status === "failed").length} failed; ${observations.filter(({ status }) => status === "skipped").length} unsupported-viewport cells skipped. Timing summaries retain completed intervals with browser errors; failures are never passing proof. Browser-local boot milestones, metrics, counts, CPU coverage, host load and errors: [observations](observations.json), [summary](summary.json), [manifest](manifest.json).`,
    "",
    ...(observations.some((row) => row.idle)
      ? [
          `Idle warmup defaults to 60000 ms for hidden scenarios and 0 ms for visible scenarios, after visibility settles. ${idleWarmupOverrideMs === undefined ? "No CLI warmup override was supplied." : `The CLI warmup override is ${idleWarmupOverrideMs} ms.`} Resolved warmup is recorded per scenario in the manifest and per idle observation. Explicit --idle-warmup-ms 0 measures the initial transition, including browser reclamation; do not extrapolate it as sustained idle CPU. Counter/request endpoints include measurement instrumentation setup/draining but exclude warmup and reveal/recovery; resourceIntervalMs records the counter window.`,
          "",
        ]
      : []),
    "Firefox uses the pinned Playwright build. Its mobile cells emulate viewport and touch only (isMobile is unsupported). CPU/native traces/heap snapshots are unavailable; application elapsed time keeps the same browser-local boundaries. Layout Instability and Long Tasks support are detected per observation; missing entries remain null.",
    "",
    "ResizeObserver loop errors are counted in every run, including without tracing or observer-origin diagnostics. Any browser error fails its observation and the command; completed timing intervals do not waive the zero-error requirement.",
    "",
    "| Configuration | Viewport | Scenario | Network | Bundle | Engine | ResizeObserver errors | Affected / attempted observations |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: |",
    ...summary.map(
      (row) =>
        `| ${row.configuration} | ${row.viewport} | ${row.step} | ${row.networkProfile} | ${row.bundle} | ${row.engine} | ${row.resizeErrorCount} | ${row.resizeErrorObservations} / ${row.passed + row.failed} |`,
    ),
    "",
    `Network profiles: ${networkProfiles.map(({ name, httpLatencyMs, gatewayLatencyMs }) => `${name} (${httpLatencyMs} ms per HTTP request; ${gatewayLatencyMs} ms per incoming Gateway frame)`).join("; ")}. The Gateway probe retains event ordering and uses no extra frame gap or throughput cap.`,
    "",
    "Application elapsed is first trusted native input (or an explicitly marked Gateway response delivery) to last observed DOM commit/native value edit before scenario return. Gateway marks run inside the page immediately before releasing the deferred response. It excludes the initial driver prefix and later assertion/settle tail, but includes intermediate driver gaps in compound actions; it is not CPU or paint latency. Navigation/memory and actions without both boundaries are unranked. The driver prefix may include application focus work. Browser-local phases do not include boundary RPC transport and do not sum to Node wall time.",
    "",
    "| Engine | Configuration | Viewport | Scenario | Network | Bundle | Chromium application median/p95 (ms) | Compared application median/p95 (ms) | Application /C | Driver /C | Chromium wall median/p95 (ms) | Compared wall median/p95 (ms) | Wall /C |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(({ engine, chromium, compared, ratio, driverRatio, wallRatio }) => {
      const format = (
        value: ReturnType<typeof distribution> | undefined,
        cell: typeof chromium | undefined,
      ) =>
        value
          ? `${value.median.toFixed(1)} / ${value.p95.toFixed(1)} (n=${value.n})`
          : cell?.skipped
            ? "unsupported viewport"
            : cell?.failed
              ? "failed/unavailable"
              : "unavailable";
      return `| ${engine} | ${chromium.configuration} | ${chromium.viewport} | ${chromium.step} | ${chromium.networkProfile} | ${chromium.bundle} | ${format(chromium.actionTiming.applicationMs, chromium)} | ${format(compared?.actionTiming.applicationMs, compared)} | ${ratio?.toFixed(2) ?? "—"} | ${driverRatio?.toFixed(2) ?? "—"} | ${format(chromium.wallMs, chromium)} | ${format(compared?.wallMs, compared)} | ${wallRatio?.toFixed(2) ?? "—"} |`;
    }),
    ...(rows.some(({ chromiumReady, comparedReady }) => chromiumReady || comparedReady)
      ? [
          "",
          "## Boot and page readiness",
          "",
          `CPU throttle: ${cpuThrottle}x (Chromium only). Long-task target: ${50 * cpuThrottle} ms. CLS target: 0; all-shift sum also includes shifts within 500 ms of user input. Missing WebKit/Firefox observer entries are unavailable, never zero. Inspector phases require a separate traced run and are elapsed wall time in WebKit, thread CPU in Chromium. Wall includes driver and assertions.`,
          "",
          "Visit and departure comparisons use browser-local route readiness; content complete also waits for the fixture's full row/control counts. CPU and task collection spans both boundaries. Action comparisons above use native-input-to-commit timing.",
          "",
          "| Engine | Configuration | Viewport | Phase | Network | Bundle | Chromium route-ready median/p95 ms | Compared route-ready median/p95 ms | Ready /C |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...rows
            .filter(({ chromiumReady, comparedReady }) => chromiumReady || comparedReady)
            .map(({ engine, chromium, chromiumReady, comparedReady, routeReadyRatio }) => {
              const format = (value: ReturnType<typeof distribution> | undefined) =>
                value ? `${value.median.toFixed(1)} / ${value.p95.toFixed(1)}` : "unavailable";
              return `| ${engine} | ${chromium.configuration} | ${chromium.viewport} | ${chromium.step} | ${chromium.networkProfile} | ${chromium.bundle} | ${format(chromiumReady)} | ${format(comparedReady)} | ${routeReadyRatio?.toFixed(2) ?? "—"} |`;
            }),
          "",
          "| Engine | Viewport | Phase | Network | Bundle | Passed/failed | Route ready median/p95 ms | Content complete median/p95 ms | Wall median/p95 ms | Ready assets / HTTP/1.1 wave floor | Longest task p95 ms | Script/style/layout median ms | CLS max | All shifts max | Elements after |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...summary
            .filter(({ step }) => step.startsWith("page-"))
            .map((row) => {
              const number = (value: number | undefined) => value?.toFixed(2) ?? "unavailable";
              const readyTiming = row.evidence.visitReadyMs ?? row.evidence.leaveReadyMs;
              const completeTiming = row.evidence.contentReadyMs;
              return `| ${row.engine} | ${row.viewport} | ${row.step} | ${row.networkProfile} | ${row.bundle} | ${row.passed}/${row.failed} | ${number(readyTiming?.median)}/${number(readyTiming?.p95)} | ${number(completeTiming?.median)}/${number(completeTiming?.p95)} | ${number(row.wallMs?.median)}/${number(row.wallMs?.p95)} | ${number(row.pageMetrics.assetRequestsCompletedByReady?.median)}/${number(row.pageMetrics.http1AssetConnectionWavesByReady?.median)} | ${number(row.pageMetrics.longestLongTaskMs?.p95)} | ${number(row.metrics.scriptMs?.median)}/${number(row.metrics.styleMs?.median)}/${number(row.metrics.layoutMs?.median)} | ${number(row.pageMetrics.cls?.max)} | ${number(row.pageMetrics.allShiftSum?.max)} | ${number(row.pageMetrics.elementsAfter?.median)} |`;
            }),
        ]
      : []),
    "",
    ...(values["mutation-audit"]
      ? [
          "## Mutation census (diagnostic overhead; not timing evidence)",
          "",
          "Value no-op ratio counts individual attribute/text writes. Same-node moves preserve identity; different-node identical-content pairs are replacement candidates, not proof of a bug. Signatures are sampled at observer delivery. Screenshot changes include caret/animation noise. Formatter counts include all instrumented calls, not just rows; translation lookups are not instrumented.",
          "",
          "| Engine | Flow | Bundle | Attribute no-ops / writes | Text no-ops / writes | Value no-op % | Suspect operations % | Moved identical | Recreated identical | Changed viewport % | Formatter calls |",
          "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
          ...observations
            .filter((row) => row.mutations)
            .map((row) => {
              const audit = row.mutations!;
              return `| ${row.engine} | ${row.step} | ${row.bundle} | ${audit.unchangedAttributes}/${audit.attributes} | ${audit.unchangedText}/${audit.text} | ${(100 * audit.valueNoopRatio).toFixed(1)} | ${(100 * audit.noopOperationRatio).toFixed(1)} | ${audit.movedIdentical} | ${audit.recreatedIdentical} | ${((row.pixels?.changedPixelRatio ?? 0) * 100).toFixed(2)} | ${Object.values(audit.formatters).reduce((sum, count) => sum + count, 0)} |`;
            }),
          "",
        ]
      : []),
    "Memory checkpoints follow two explicit GCs. WebKit snapshot self sizes omit some backing stores; engine categories and browser-tree RSS provide separate native/allocation evidence. RSS includes Inspector overhead and may exclude reparented platform services. Compare warm-to-late checkpoints within an engine, not absolute heap sizes between engines. Detached counts cover JSC wrappers versus V8 native DOM nodes; see per-checkpoint notes and unresolved counts. Memory scenario durations are excluded from the timing table.",
    "",
    "| Engine | Scenario | Bundle/pair | Checkpoint | Heap MiB | Engine MiB | Browser-tree RSS MiB | Detached | Unknown |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...observations.flatMap((row) =>
      (row.memory ?? []).map(({ checkpoint, metrics, process: memory }) => {
        const mib = (bytes: number) => (bytes / 1024 ** 2).toFixed(2);
        return `| ${row.engine} | ${row.step} | ${row.bundle}/${row.pair + 1} | ${checkpoint} | ${mib(metrics.heapUsedBytes)} | ${metrics.engineMemory ? mib(metrics.engineMemory.bytes) : "—"} | ${mib(memory.processTreeRssBytes)} | ${metrics.dom.detachedNodes} | ${metrics.dom.unresolvedDetachedness} |`;
      }),
    ),
    "",
  ].join("\n"),
);
console.log(`Cross-engine artifacts: ${artifactDir}`);
if (observations.some(({ status }) => status === "failed")) {
  process.exitCode = 1;
}
