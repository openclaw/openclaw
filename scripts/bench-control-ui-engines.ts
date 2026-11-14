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
import { chromium as chromiumEngine, webkit as webkitEngine, type Browser } from "playwright";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import {
  createChatComposerScenarios,
  installChatActionObservation,
  readChatActionObservation,
} from "./lib/control-ui-chat-composer-scenarios.ts";
import { createChatMessageScenarios } from "./lib/control-ui-chat-message-scenarios.ts";
import { createChatPanelScenarios } from "./lib/control-ui-chat-panel-scenarios.ts";
import { createEngineActionScenarios } from "./lib/control-ui-engine-action-scenarios.ts";
import {
  createEngineActionTiming,
  type EngineActionTiming,
} from "./lib/control-ui-engine-action-timing.ts";
import {
  createEngineBootScenarios,
  type EngineScenario,
} from "./lib/control-ui-engine-boot-scenarios.ts";
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
  finishControlUiPageObserver,
  installControlUiPageObserver,
  readControlUiPageObserver,
  resetControlUiPageObserver,
  type ControlUiPageObservation,
} from "./lib/control-ui-page-observer.ts";
import { installControlUiResourceCounts } from "./lib/control-ui-resource-counts.ts";
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
    viewport: { type: "string", default: "both" },
    steps: { type: "string" },
    pages: { type: "boolean", default: false },
    "page-phases": { type: "string", default: "visit,action,leave" },
    pairs: { type: "string", default: "1" },
    trace: { type: "boolean", default: false },
    "observer-origins": { type: "boolean", default: false },
    "cpu-only": { type: "boolean", default: false },
    "cpu-throttle": { type: "string", default: "1" },
    "memory-soak-rounds": { type: "string", default: "10" },
  },
});
const pairs = Number(values.pairs);
const memorySoakRounds = Number(values["memory-soak-rounds"]);
if (!Number.isInteger(memorySoakRounds) || memorySoakRounds < 1 || memorySoakRounds > 10) {
  throw new Error("memory-soak-rounds must be an integer from 1 to 10");
}
const pageBenchmark = values.pages || values.steps?.split(",").some((id) => id.startsWith("page-"));
const pagePhases = values["page-phases"].split(",");
if (pagePhases.some((phase) => !["visit", "action", "leave"].includes(phase))) {
  throw new Error("page-phases must contain visit, action and/or leave");
}
const engines: ControlUiEngine[] = values.engines.split(",").map((name) => {
  if (name !== "chromium" && name !== "webkit") {
    throw new Error(`Unsupported engine: ${name}`);
  }
  return name;
});
const cpuThrottle = Number(values["cpu-throttle"]);
if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
  throw new Error("cpu-throttle must be at least 1");
}
if (cpuThrottle !== 1 && engines.includes("webkit")) {
  throw new Error(
    "WebKit does not expose CPU throttling; use --engines chromium for throttled runs",
  );
}
const networkProfiles = values["network-profiles"].split(",").map((name) => {
  if (name !== "localhost" && name !== "rtt-100ms") {
    throw new Error(`Unsupported network profile: ${name}`);
  }
  const latencyMs = name === "localhost" ? 0 : 100;
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
  values.pages ||
  values.steps
    ?.split(",")
    .some(
      (id) =>
        id.startsWith("workboard-") ||
        /^page-(?:workboard|plugin)-(?:visit|action|leave)$/u.test(id),
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
  engine: ControlUiEngine;
  networkProfile: NetworkProfile["name"];
  viewport: string;
  step: string;
  bundle: number;
  pair: number;
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
  resizeErrorCount?: number;
  artifactPrefix: string;
};
const observations: Observation[] = [];
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
    ...createChatComposerScenarios(),
    ...createChatMessageScenarios(),
    ...createChatPanelScenarios().map((scenario) =>
      Object.assign(scenario, { explicitOnly: true }),
    ),
    ...createEngineStyleScenarios(),
    ...createEngineMemoryScenarios(memorySoakRounds),
    ...createEnginePluginMemoryScenarios(),
    ...createEngineStreamingScenarios(),
    ...createEnginePageScenarios(),
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
    id === "chat-actions"
      ? catalog
          .filter((scenario) => scenario.id.startsWith("chat-actions-"))
          .map((scenario) => scenario.id)
      : [id],
  );
  const scenarios = catalog.filter(({ id, explicitOnly, memory }) =>
    ids
      ? ids.some((selected) => selected === id || (selected === "memory" && memory))
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
  if (
    networkProfiles.some(({ name }) => name !== "localhost") &&
    scenarios.some(({ id }) => id !== "cold-boot" && id !== "warm-boot")
  ) {
    throw new Error("Nonlocal --network-profiles require --steps cold-boot,warm-boot");
  }
  planned =
    scenarios.length *
    viewports.length *
    pairs *
    engines.length *
    servers.length *
    networkProfiles.length;
  await writeJson("manifest.json", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    harnessSources: Object.fromEntries(
      await Promise.all(
        [
          "./bench-control-ui-engines.ts",
          "./lib/control-ui-engine-metrics.ts",
          "./lib/control-ui-engine-boot-scenarios.ts",
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
          "./lib/control-ui-page-observer.ts",
          "./lib/control-ui-bench-gateway-server.ts",
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
    trace: values.trace,
    observerOrigins: values["observer-origins"],
    cpuOnly: values["cpu-only"],
    cpuThrottle,
    memorySoakRounds,
    collection: values.trace
      ? "Playwright tracing and engine Inspector/Profiler; overhead included"
      : values["cpu-only"]
        ? "WebKit smoothed utilization diagnostic (not action CPU) and Chromium CDP thread CPU; no timeline or script profiler"
        : "Untraced wall time; Chromium CDP counters only, unavailable WebKit counters are null",
    order:
      "Serial network profile, engine and bundle order alternates each pair; fresh browser context per observation",
    acceptance:
      "Census ranks >1.3x WebKit/Chromium. Fix proof: ten interleaved pairs plus A/A control; median regression <=5% and p95 no worse, otherwise ten more pairs. Profile/CPU and structural counts decide on a noisy host; >20% attributable regression blocks.",
    frameCadence:
      "Prepare and settle frame intervals are consecutive requestAnimationFrame timestamp differences, not the full wait duration. scenarioMs includes driver input and scenario assertions; settleWaitMs measures the final two-frame wait. Their sum is wallMs. These are automation-to-assertion timings, not input-to-paint latency. Browser-local actionTiming splits the driver prefix, application elapsed to the last observed DOM commit (or native value edit), and the assertion/settle tail. These three sum to browserSpanMs, not Node wallMs. Focus work can occur in the prefix; compound input spans retain intermediate driver delays. Trace-only marks expose the same boundaries. Missing native input/commit makes action timing unavailable.",
    boundary:
      "Production bundle and HTTP owner; synthetic Gateway. Cold means fresh context; warm means same-context document reload. Mock routing disables HTTP cache in both engines. Nonlocal profiles add the configured delay to every HTTP request and every incoming mock Gateway frame (including the connect challenge); RPC replies thus include a simulated round trip, with no added throughput cap. Mobile transcript-top uses a native scrollport jump, not wheel input. No live Gateway/provider latency.",
    memoryContract:
      "Opt-in memory-* scenes retain one document, drain 4.1 s retirement timers, clear synthetic request history, then force two collections at each named checkpoint. Compare warm and late checkpoints; heap/native categories/RSS and DOM wrapper/native counts have different engine-specific meanings. Memory-scene elapsed times include forced GC and snapshots and are not latency evidence.",
    scenarios: scenarios.map(
      ({ id, route, expected, navigation, memory, diagnostic, viewports: scenarioViewports }) => ({
        id,
        route,
        expected,
        navigation,
        memory,
        diagnostic,
        viewports: scenarioViewports,
      }),
    ),
    ...(pageBenchmark
      ? { pageCoverage: enginePageCoverage, pageFixtureCounts: enginePageFixtureCounts }
      : {}),
  });
  for (const viewport of viewports) {
    for (const item of scenarios) {
      for (let pair = 0; pair < pairs; pair++) {
        const orderedEngines = pair % 2 ? engines.toReversed() : engines;
        const slots = pair % 2 ? [...servers.entries()].toReversed() : [...servers.entries()];
        const orderedProfiles = pair % 2 ? networkProfiles.toReversed() : networkProfiles;
        for (const { networkProfile, engine } of orderedProfiles.flatMap((selectedProfile) =>
          orderedEngines.map((selectedEngine) => ({
            networkProfile: selectedProfile,
            engine: selectedEngine,
          })),
        )) {
          for (const [bundle, slot] of slots) {
            slot.server.setAssetLatencyMs(networkProfile.httpLatencyMs);
            const scenario =
              createEngineBootScenarios(slot.server.baseUrl, networkProfile.gatewayLatencyMs).find(
                ({ id }) => id === item.id,
              ) ?? item;
            const artifactPrefix = `${viewport.name}-${scenario.id}-${networkProfile.name}-${pair + 1}-${engine}-${bundle}`;
            const observation: Observation = {
              engine,
              networkProfile: networkProfile.name,
              viewport: viewport.name,
              step: scenario.id,
              bundle,
              pair,
              status: "failed",
              hostLoadAverage: os.loadavg(),
              artifactPrefix,
            };
            if (scenario.viewports && !scenario.viewports.some((name) => name === viewport.name)) {
              observation.status = "skipped";
              observation.skipReason = "This control is unavailable at this viewport.";
              observations.push(observation);
              await writeJson(`${artifactPrefix}.json`, observation);
              await writeJson("observations.json", observations);
              continue;
            }
            if (scenario.memory || !browsers.get(engine)!.isConnected()) {
              await browsers.get(engine)!.close();
              browsers.set(engine, await launchEngine(engine));
            }
            const observationBrowser = browsers.get(engine)!;
            const context = await observationBrowser.newContext({
              viewport: { width: viewport.width, height: viewport.height },
              isMobile: viewport.name === "mobile",
              hasTouch: viewport.name === "mobile",
              serviceWorkers: "block",
              colorScheme: "light",
            });
            const page = await context.newPage();
            page.setDefaultTimeout(scenario.id.startsWith("chat-actions-") ? 15_000 : 30_000);
            const traceAction = values.trace && !scenario.navigation;
            const errors: Array<{ message: string; phase: string }> = [];
            let phase = "setup";
            page.on("pageerror", (error: Error) => errors.push({ message: error.message, phase }));
            let tracingStarted = false;
            let measurement: Awaited<ReturnType<typeof startEngineMeasurement>> | undefined;
            let memory: Awaited<ReturnType<typeof createEngineMemoryCollector>> | undefined;
            let throttle: Awaited<ReturnType<typeof context.newCDPSession>> | undefined;
            try {
              if (cpuThrottle !== 1) {
                throttle = await context.newCDPSession(page);
                await throttle.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
              }
              await page.addInitScript("globalThis.__name = (fn) => fn");
              if (scenario.id.startsWith("page-")) {
                await installControlUiPageObserver(page);
              }
              await page.addInitScript(installInteractionNavigationPreloadObserver);
              if (scenario.memory) {
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
              await page.addInitScript(
                ({ key, gatewayUrl, settings }) => {
                  if (window === window.top) {
                    localStorage.setItem(
                      key,
                      JSON.stringify({ ...settings, gatewayUrl, lobsterPetVisits: false }),
                    );
                  }
                },
                {
                  key: controlUiBundledSettingsStorageKey(slot.server.baseUrl),
                  gatewayUrl: controlUiBundledGatewayUrl(slot.server.baseUrl),
                  settings: scenario.settings,
                },
              );
              const fixture: ReturnType<typeof createScenarioFixture> = scenario.fixture
                ?.workboardResources
                ? createWorkboardResourceFixture(
                    slot.build.buildId,
                    slot.build.version,
                    slot.workboardSource!.root,
                  )
                : createScenarioFixture(slot.build.buildId, slot.build.version, scenario);
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
              const gateway = await installMockGateway(
                page,
                { ...fixture, awaitInitialRoster: false },
                {
                  requestHandlers: { ...defaults, ...scenario.createRequestHandlers?.(defaults) },
                  afterInitScript: scenario.initScript,
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
                await waitForControlUiInitialRoster(page, 30_000);
              }
              await scenario.prepare(page, gateway);
              if (scenario.navigation !== "measured") {
                observation.navigationPreloads = await settleInteractionNavigationPreloads(page);
                await page.waitForLoadState("networkidle");
                await page.evaluate(() => document.fonts.ready.then(() => undefined));
                observation.prepareFrameIntervalMs = await frames(page);
              }
              const before = (await gateway.getRequests()).length;
              if (values.trace) {
                // DOM snapshots execute injected script on each action and distort the profile.
                await context.tracing.start({
                  screenshots: false,
                  snapshots: false,
                  sources: true,
                });
                tracingStarted = true;
              }
              if (scenario.id.startsWith("page-")) {
                await resetControlUiPageObserver(page);
              }
              if (scenario.id.startsWith("chat-actions-")) {
                await installChatActionObservation(
                  page,
                  values.trace,
                  scenario.id === "chat-actions-fork",
                );
              }
              const actionTiming =
                !scenario.navigation && !scenario.memory
                  ? await page.evaluateHandle(createEngineActionTiming, traceAction)
                  : undefined;
              measurement = await startEngineMeasurement(page, engine, {
                trace: values.trace,
                cpuOnly: values["cpu-only"],
              });
              phase = "measurement";
              const start = performance.now();
              if (scenario.memory) {
                memory = await createEngineMemoryCollector(page, engine);
                observation.memory = [];
              }
              const timeOrigin = actionTiming
                ? await actionTiming.evaluate((timing) => timing.start())
                : await page.evaluate(() => performance.timeOrigin);
              if (memory) {
                // Bind checkpoints to this document, independently of wall-clock adjustments.
                await page.evaluate((identity) => {
                  Reflect.set(window, "openclawMemoryDocumentIdentity", identity);
                }, artifactPrefix);
              }
              observation.evidence =
                (await scenario.run(
                  page,
                  gateway,
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
                          path.join(artifactDir, `${artifactPrefix}-${checkpoint}.heapsnapshot`),
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
              observation.settleFrameIntervalMs = await frames(page);
              observation.wallMs = performance.now() - start;
              observation.settleWaitMs = observation.wallMs - observation.scenarioMs;
              if (scenario.id.startsWith("page-")) {
                await finishControlUiPageObserver(page);
              }
              if (actionTiming) {
                observation.actionTiming = await actionTiming.evaluate((timing) => timing.finish());
                await actionTiming.dispose();
              }
              const activeMeasurement = measurement;
              measurement = undefined;
              const captured = await activeMeasurement.stop();
              observation.metrics = captured.metrics;
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
                // The earlier reset counts initial DOM outside CPU collection. Exclude
                // CDP/profiler setup from long tasks and shifts using the actual action boundary.
                observation.pageMetrics = await readControlUiPageObserver(
                  page,
                  observation.actionTiming?.startMs,
                );
                observation.evidence = {
                  ...observation.evidence,
                  ...(await collectEnginePageStructure(page)),
                };
              }
              if (values.trace || values["cpu-only"]) {
                await writeJson(`${artifactPrefix}.inspector.json`, captured);
              }
              observation.requests = {};
              for (const { method } of (await gateway.getRequests()).slice(
                scenario.navigation || scenario.memory ? 0 : before,
              )) {
                observation.requests[method] = (observation.requests[method] ?? 0) + 1;
              }
              if (errors.length) {
                throw new Error(errors.map(({ message }) => message).join("\n"));
              }
              observation.status = "passed";
            } catch (error) {
              observation.error = String(error);
            } finally {
              phase = "capture";
              observation.errorEvents = errors;
              try {
                await memory?.dispose();
                if (values.trace || values["observer-origins"]) {
                  const resizeErrors: unknown[] = await page.evaluate(() =>
                    Reflect.get(window, "__engineResizeErrors"),
                  );
                  observation.resizeErrorCount = resizeErrors.length;
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
                if (scenario.memory) {
                  await observationBrowser.close();
                }
              }
              observations.push(observation);
              await writeJson(`${artifactPrefix}.json`, observation);
              await writeJson("observations.json", observations);
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
  for (const browser of browsers.values()) {
    await browser.close();
  }
  for (const { server } of servers) {
    await server.close();
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
  Pick<Observation, "viewport" | "step" | "engine" | "bundle" | "networkProfile">
>();
for (const { viewport, step, engine, bundle, networkProfile, memory } of observations) {
  if (memory) {
    continue;
  }
  cells.set(JSON.stringify([viewport, step, engine, bundle, networkProfile]), {
    viewport,
    step,
    engine,
    bundle,
    networkProfile,
  });
}
const summary = [...cells.values()].map((cell) => {
  const rows = observations.filter(
    (row) =>
      row.viewport === cell.viewport &&
      row.step === cell.step &&
      row.engine === cell.engine &&
      row.bundle === cell.bundle &&
      row.networkProfile === cell.networkProfile,
  );
  const passing = rows.filter((row) => row.status === "passed");
  // Keep completed intervals with browser errors visible; dropping them biases a buggy base.
  const measured = rows.filter((row) => row.wallMs !== undefined);
  const pageRows = measured.flatMap((row) => row.pageMetrics ?? []);
  const longestTasks = pageRows.flatMap((row) => row.longestLongTaskMs ?? []);
  const shifts = pageRows.flatMap((row) => row.cls ?? []);
  return {
    viewport: cell.viewport,
    step: cell.step,
    engine: cell.engine,
    bundle: cell.bundle,
    networkProfile: cell.networkProfile,
    passed: passing.length,
    failed: rows.filter((row) => row.status === "failed").length,
    skipped: rows.filter((row) => row.status === "skipped").length,
    measured: measured.length,
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
  .map((chromium) => {
    const webkit = summary.find(
      (row) =>
        row.engine === "webkit" &&
        row.step === chromium.step &&
        row.viewport === chromium.viewport &&
        row.bundle === chromium.bundle &&
        row.networkProfile === chromium.networkProfile,
    );
    const application = chromium.actionTiming.applicationMs;
    const webkitApplication = webkit?.actionTiming.applicationMs;
    const driver = chromium.actionTiming.driverMs;
    const webkitDriver = webkit?.actionTiming.driverMs;
    const ratio =
      application && webkitApplication && application.median > 0
        ? webkitApplication.median / application.median
        : null;
    const driverRatio =
      driver && webkitDriver && driver.median > 0 ? webkitDriver.median / driver.median : null;
    const wallRatio =
      chromium.wallMs && webkit?.wallMs ? webkit.wallMs.median / chromium.wallMs.median : null;
    const chromiumReady = chromium.evidence.visitReadyMs ?? chromium.evidence.leaveReadyMs;
    const webkitReady = webkit?.evidence.visitReadyMs ?? webkit?.evidence.leaveReadyMs;
    const routeReadyRatio =
      chromiumReady && webkitReady && chromiumReady.median > 0
        ? webkitReady.median / chromiumReady.median
        : null;
    return {
      chromium,
      webkit,
      ratio,
      driverRatio,
      wallRatio,
      chromiumReady,
      webkitReady,
      routeReadyRatio,
    };
  })
  .toSorted((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
await writeJson("summary.json", {
  headlineMetric: "applicationMs",
  comparisons: rows.map(({ chromium, ratio, driverRatio, wallRatio, routeReadyRatio }) => ({
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
  skipped: planned - observations.length,
  ...(pageBenchmark ? { pageCoverage: enginePageCoverage } : {}),
  passed: observations.filter((row) => row.status === "passed").length,
  summary,
  memory: observations.flatMap((row) =>
    (row.memory ?? []).map((checkpoint) =>
      Object.assign(
        {
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
    `Synthetic Gateway; production HTTP/bundle. ${values.trace ? "Traced samples include profiler overhead." : values["cpu-only"] ? "Sampled WebKit process CPU; Chromium main-thread CPU. No timeline or script profiler." : "Untraced wall samples; WebKit Inspector counters are unavailable (null)."} Wall time includes automation and assertions, not INP. WebKit Inspector script/layout/style durations are wall time; Chromium CDP uses thread CPU. Do not compare these as CPU ratios. Cold contexts are fresh; warm reload retains IndexedDB but mock routing disables HTTP cache.`,
    "",
    `Completed ${observations.length}/${planned} observations; ${observations.filter(({ status }) => status === "failed").length} failed; ${observations.filter(({ status }) => status === "skipped").length} unsupported-viewport cells skipped. Timing summaries retain completed intervals with browser errors; failures are never passing proof. Browser-local boot milestones, metrics, counts, CPU coverage, host load and errors: [observations](observations.json), [summary](summary.json), [manifest](manifest.json).`,
    "",
    `Network profiles: ${networkProfiles.map(({ name, httpLatencyMs, gatewayLatencyMs }) => `${name} (${httpLatencyMs} ms per HTTP request; ${gatewayLatencyMs} ms per incoming Gateway frame)`).join("; ")}. The Gateway probe retains event ordering and uses no extra frame gap or throughput cap.`,
    "",
    "Application elapsed is first trusted action event to last observed DOM commit/native value edit before scenario return. It excludes the initial driver prefix and later assertion/settle tail, but includes intermediate driver gaps in compound actions; it is not CPU or paint latency. Navigation/memory and actions without both boundaries are unranked. The driver prefix may include application focus work. Browser-local phases do not include boundary RPC transport and do not sum to Node wall time.",
    "",
    "| Viewport | Scenario | Network | Bundle | Chromium application median/p95 (ms) | WebKit application median/p95 (ms) | Application W/C | Driver W/C | Chromium wall median/p95 (ms) | WebKit wall median/p95 (ms) | Wall W/C |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(({ chromium, webkit, ratio, driverRatio, wallRatio }) => {
      const format = (
        value: ReturnType<typeof distribution> | undefined,
        cell: typeof chromium | undefined,
      ) =>
        value
          ? `${value.median.toFixed(1)} / ${value.p95.toFixed(1)} (n=${value.n})`
          : cell?.skipped
            ? "unsupported viewport"
            : "failed/absent";
      return `| ${chromium.viewport} | ${chromium.step} | ${chromium.networkProfile} | ${chromium.bundle} | ${format(chromium.actionTiming.applicationMs, chromium)} | ${format(webkit?.actionTiming.applicationMs, webkit)} | ${ratio?.toFixed(2) ?? "—"} | ${driverRatio?.toFixed(2) ?? "—"} | ${format(chromium.wallMs, chromium)} | ${format(webkit?.wallMs, webkit)} | ${wallRatio?.toFixed(2) ?? "—"} |`;
    }),
    ...(summary.some(({ step }) => step.startsWith("page-"))
      ? [
          "",
          "## Per-page phases",
          "",
          `CPU throttle: ${cpuThrottle}x (Chromium only). Long-task target: ${cpuThrottle === 1 ? 50 : 200} ms. CLS target: 0; all-shift sum also includes shifts within 500 ms of user input. Missing WebKit observer entries are unavailable, never zero. Inspector phases require a separate traced run and are elapsed wall time in WebKit, thread CPU in Chromium. Wall includes driver and assertions.`,
          "",
          "Visit and departure comparisons use browser-local route readiness; content complete also waits for the fixture's full row/control counts. CPU and task collection spans both boundaries. Action comparisons above use native-input-to-commit timing.",
          "",
          "| Viewport | Phase | Network | Bundle | Chromium route-ready median/p95 ms | WebKit route-ready median/p95 ms | Ready W/C |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          ...rows
            .filter(({ chromiumReady, webkitReady }) => chromiumReady || webkitReady)
            .map(({ chromium, chromiumReady, webkitReady, routeReadyRatio }) => {
              const format = (value: ReturnType<typeof distribution> | undefined) =>
                value ? `${value.median.toFixed(1)} / ${value.p95.toFixed(1)}` : "unavailable";
              return `| ${chromium.viewport} | ${chromium.step} | ${chromium.networkProfile} | ${chromium.bundle} | ${format(chromiumReady)} | ${format(webkitReady)} | ${routeReadyRatio?.toFixed(2) ?? "—"} |`;
            }),
          "",
          "| Engine | Viewport | Phase | Bundle | Passed/failed | Route ready median/p95 ms | Content complete median/p95 ms | Wall median/p95 ms | Longest task p95 ms | Script/style/layout median ms | CLS max | All shifts max | Elements after |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          ...summary
            .filter(({ step }) => step.startsWith("page-"))
            .map((row) => {
              const number = (value: number | undefined) => value?.toFixed(2) ?? "unavailable";
              const readyTiming = row.evidence.visitReadyMs ?? row.evidence.leaveReadyMs;
              const completeTiming = row.evidence.contentReadyMs;
              return `| ${row.engine} | ${row.viewport} | ${row.step} | ${row.bundle} | ${row.passed}/${row.failed} | ${number(readyTiming?.median)}/${number(readyTiming?.p95)} | ${number(completeTiming?.median)}/${number(completeTiming?.p95)} | ${number(row.wallMs?.median)}/${number(row.wallMs?.p95)} | ${number(row.pageMetrics.longestLongTaskMs?.p95)} | ${number(row.metrics.scriptMs?.median)}/${number(row.metrics.styleMs?.median)}/${number(row.metrics.layoutMs?.median)} | ${number(row.pageMetrics.cls?.max)} | ${number(row.pageMetrics.allShiftSum?.max)} | ${number(row.pageMetrics.elementsAfter?.median)} |`;
            }),
        ]
      : []),
    "",
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
