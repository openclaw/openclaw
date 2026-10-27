// Cross-engine companion to the CDP-only cold-load and interaction benchmarks.
// Uses their production HTTP server, synthetic Gateway, scenarios and assertions.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium as chromiumEngine, webkit as webkitEngine, type Browser } from "playwright";
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
import { createEngineActionScenarios } from "./lib/control-ui-engine-action-scenarios.ts";
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
import { createEnginePluginMemoryScenarios } from "./lib/control-ui-engine-plugin-memory-scenarios.ts";
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
    viewport: { type: "string", default: "both" },
    steps: { type: "string" },
    pairs: { type: "string", default: "1" },
    trace: { type: "boolean", default: false },
    "cpu-only": { type: "boolean", default: false },
  },
});
const pairs = Number(values.pairs);
const engines = values.engines.split(",").map((name) => {
  if (name !== "chromium" && name !== "webkit") {
    throw new Error(`Unsupported engine: ${name}`);
  }
  return name;
});
if (!Number.isInteger(pairs) || pairs < 1 || new Set(engines).size !== engines.length) {
  throw new Error("Use positive integer --pairs and distinct engines");
}
if (!["desktop", "mobile", "both"].includes(values.viewport)) {
  throw new Error("Invalid viewport");
}
if (values["control-bundle-dir"]?.length && !values["compare-bundle-dir"]) {
  throw new Error("--control-bundle-dir requires --compare-bundle-dir");
}
if (values.trace && values["cpu-only"]) {
  throw new Error("Choose --trace or --cpu-only; use separate untraced timing runs");
}
const artifactDir = createControlUiE2eArtifactDir("engines", values.output);
// Playwright's temporary profiles and downloads belong with this run, too.
process.env.TMPDIR = artifactDir;
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
const needsWorkboard = values.steps?.split(",").some((id) => id.startsWith("workboard-"));
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
  viewport: string;
  step: string;
  bundle: number;
  pair: number;
  status: "passed" | "failed";
  wallMs?: number;
  hostLoadAverage: number[];
  metrics?: EngineMetrics;
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
  const ids = values.steps?.split(",");
  const catalog: EngineScenario[] = [
    ...createEngineBootScenarios(servers[0]!.server.baseUrl),
    ...createEngineActionScenarios(),
    ...createEngineStyleScenarios(),
    ...createEngineMemoryScenarios(),
    ...createEnginePluginMemoryScenarios(),
    ...interactionScenarios.filter(
      (scenario) =>
        ids?.includes(scenario.id) ||
        (!scenario.explicitOnly &&
          !scenario.resourceOnly &&
          !scenario.projectionFamily &&
          !scenario.dataPage),
    ),
  ];
  const scenarios = catalog.filter(({ id, explicitOnly, memory }) =>
    ids
      ? ids.some((selected) => selected === id || (selected === "memory" && memory))
      : !explicitOnly,
  );
  if (
    !scenarios.length ||
    ids?.some((id) => id !== "memory" && !scenarios.some((scenario) => scenario.id === id))
  ) {
    throw new Error("Unknown or empty --steps selection");
  }
  planned = scenarios.length * viewports.length * pairs * engines.length * servers.length;
  await writeJson("manifest.json", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    harnessSources: Object.fromEntries(
      await Promise.all(
        [
          "./bench-control-ui-engines.ts",
          "./lib/control-ui-engine-metrics.ts",
          "./lib/control-ui-engine-boot-scenarios.ts",
          "./lib/control-ui-engine-memory.ts",
          "./lib/control-ui-engine-memory-scenarios.ts",
          "./lib/control-ui-engine-plugin-memory-scenarios.ts",
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
    trace: values.trace,
    cpuOnly: values["cpu-only"],
    collection: values.trace
      ? "Playwright tracing and engine Inspector/Profiler; overhead included"
      : values["cpu-only"]
        ? "WebKit smoothed utilization diagnostic (not action CPU) and Chromium CDP thread CPU; no timeline or script profiler"
        : "Untraced wall time; Chromium CDP counters only, unavailable WebKit counters are null",
    order:
      "Serial engine and bundle order alternates each pair; fresh browser context per observation",
    acceptance:
      "Census ranks >1.5x WebKit/Chromium. Fix proof: ten interleaved pairs plus A/A control; median regression <=5% and p95 no worse, otherwise ten more pairs. Profile/CPU and structural counts decide on a noisy host; >20% attributable regression blocks.",
    boundary:
      "Production bundle and HTTP owner; synthetic Gateway. Cold means fresh context; warm means same-context document reload. Mock routing disables HTTP cache in both engines. Mobile transcript-top uses a native scrollport jump, not wheel input. No live Gateway/provider latency.",
    memoryContract:
      "Opt-in memory-* scenes retain one document, drain 4.1 s retirement timers, clear synthetic request history, then force two collections at each named checkpoint. Compare warm and late checkpoints; heap/native categories/RSS and DOM wrapper/native counts have different engine-specific meanings. Memory-scene elapsed times include forced GC and snapshots and are not latency evidence.",
    scenarios: scenarios.map(({ id, route, expected, navigation, memory }) => ({
      id,
      route,
      expected,
      navigation,
      memory,
    })),
  });
  for (const viewport of viewports) {
    for (const item of scenarios) {
      for (let pair = 0; pair < pairs; pair++) {
        const orderedEngines = pair % 2 ? engines.toReversed() : engines;
        const slots = pair % 2 ? [...servers.entries()].toReversed() : [...servers.entries()];
        for (const engine of orderedEngines) {
          for (const [bundle, slot] of slots) {
            const scenario =
              createEngineBootScenarios(slot.server.baseUrl).find(({ id }) => id === item.id) ??
              item;
            const artifactPrefix = `${viewport.name}-${scenario.id}-${pair + 1}-${engine}-${bundle}`;
            const observation: Observation = {
              engine,
              viewport: viewport.name,
              step: scenario.id,
              bundle,
              pair,
              status: "failed",
              hostLoadAverage: os.loadavg(),
              artifactPrefix,
            };
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
            page.setDefaultTimeout(30_000);
            const errors: Array<{ message: string; phase: string }> = [];
            let phase = "setup";
            page.on("pageerror", (error: Error) => errors.push({ message: error.message, phase }));
            let measurement: Awaited<ReturnType<typeof startEngineMeasurement>> | undefined;
            let memory: Awaited<ReturnType<typeof createEngineMemoryCollector>> | undefined;
            try {
              await page.addInitScript("globalThis.__name = (fn) => fn");
              await page.addInitScript(installInteractionNavigationPreloadObserver);
              if (scenario.memory) {
                await page.addInitScript(installControlUiResourceCounts);
              }
              await page.addInitScript(() => performance.setResourceTimingBufferSize(2048));
              if (values.trace) {
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
                ({ key, gatewayUrl }: { key: string; gatewayUrl: string }) => {
                  if (window === window.top) {
                    localStorage.setItem(
                      key,
                      JSON.stringify({ gatewayUrl, lobsterPetVisits: false }),
                    );
                  }
                },
                {
                  key: controlUiBundledSettingsStorageKey(slot.server.baseUrl),
                  gatewayUrl: controlUiBundledGatewayUrl(slot.server.baseUrl),
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
                await frames(page);
              }
              const before = (await gateway.getRequests()).length;
              if (values.trace) {
                // DOM snapshots execute injected script on each action and distort the profile.
                await context.tracing.start({
                  screenshots: false,
                  snapshots: false,
                  sources: true,
                });
              }
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
              const timeOrigin = await page.evaluate(() => performance.timeOrigin);
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
              await frames(page);
              observation.wallMs = performance.now() - start;
              const activeMeasurement = measurement;
              measurement = undefined;
              const captured = await activeMeasurement.stop();
              observation.metrics = captured.metrics;
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
                if (values.trace) {
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
                if (pair === 0 || observation.status === "failed") {
                  await page.screenshot({ path: path.join(artifactDir, `${artifactPrefix}.png`) });
                }
                if (values.trace) {
                  await context.tracing.stop({
                    path: path.join(artifactDir, `${artifactPrefix}.trace.zip`),
                  });
                }
              } catch (error) {
                observation.error = [observation.error, String(error)].filter(Boolean).join("\n");
                observation.status = "failed";
              }
              try {
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
const cells = new Map<string, Pick<Observation, "viewport" | "step" | "engine" | "bundle">>();
for (const { viewport, step, engine, bundle, memory } of observations) {
  if (memory) {
    continue;
  }
  cells.set(JSON.stringify([viewport, step, engine, bundle]), { viewport, step, engine, bundle });
}
const summary = [...cells.values()].map((cell) => {
  const rows = observations.filter(
    (row) =>
      row.viewport === cell.viewport &&
      row.step === cell.step &&
      row.engine === cell.engine &&
      row.bundle === cell.bundle,
  );
  const passing = rows.filter((row) => row.status === "passed");
  // Keep completed intervals with browser errors visible; dropping them biases a buggy base.
  const measured = rows.filter((row) => row.wallMs !== undefined);
  return {
    viewport: cell.viewport,
    step: cell.step,
    engine: cell.engine,
    bundle: cell.bundle,
    passed: passing.length,
    failed: rows.length - passing.length,
    measured: measured.length,
    wallMs: distribution(measured.map((row) => row.wallMs!)),
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
  };
});
await writeJson("summary.json", {
  planned,
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
          status: row.status,
        },
        checkpoint,
      ),
    ),
  ),
});
const rows = summary
  .filter(({ engine }) => engine === "chromium")
  .map((chromium) => {
    const webkit = summary.find(
      (row) =>
        row.engine === "webkit" &&
        row.step === chromium.step &&
        row.viewport === chromium.viewport &&
        row.bundle === chromium.bundle,
    );
    const ratio =
      chromium.wallMs && webkit?.wallMs ? webkit.wallMs.median / chromium.wallMs.median : null;
    return { chromium, webkit, ratio };
  })
  .toSorted((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
await writeFile(
  path.join(artifactDir, "report.md"),
  [
    "# Control UI engine comparison",
    "",
    `Synthetic Gateway; production HTTP/bundle. ${values.trace ? "Traced samples include profiler overhead." : values["cpu-only"] ? "Sampled WebKit process CPU; Chromium main-thread CPU. No timeline or script profiler." : "Untraced wall samples; WebKit Inspector counters are unavailable (null)."} Wall time includes automation and assertions, not INP. WebKit Inspector script/layout/style durations are wall time; Chromium CDP uses thread CPU. Do not compare these as CPU ratios. Cold contexts are fresh; warm reload retains IndexedDB but mock routing disables HTTP cache.`,
    "",
    `Completed ${observations.length}/${planned} observations; ${observations.filter(({ status }) => status === "failed").length} failed. Timing summaries retain completed intervals with browser errors; failures are never passing proof. Browser-local boot milestones, metrics, counts, CPU coverage, host load and errors: [observations](observations.json), [summary](summary.json), [manifest](manifest.json).`,
    "",
    "| Viewport | Scenario | Bundle | Chromium wall median/p95 (ms) | WebKit wall median/p95 (ms) | WebKit/Chromium |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(({ chromium, webkit, ratio }) => {
      const format = (value: ReturnType<typeof distribution> | undefined) =>
        value
          ? `${value.median.toFixed(1)} / ${value.p95.toFixed(1)} (n=${value.n})`
          : "failed/absent";
      return `| ${chromium.viewport} | ${chromium.step} | ${chromium.bundle} | ${format(chromium.wallMs)} | ${format(webkit?.wallMs)} | ${ratio?.toFixed(2) ?? "—"} |`;
    }),
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
