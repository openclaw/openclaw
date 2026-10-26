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
import {
  startEngineMeasurement,
  type ControlUiEngine,
  type EngineMetrics,
} from "./lib/control-ui-engine-metrics.ts";
import { frames } from "./lib/control-ui-interaction-navigation.ts";
import {
  createScenarioFixture,
  interactionScenarios,
  installInteractionNavigationPreloadObserver,
  settleInteractionNavigationPreloads,
  type InteractionNavigationPreloads,
  type InteractionEvidence,
} from "./lib/control-ui-interaction-scenarios.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    "control-bundle-dir": { type: "string" },
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
if (values["control-bundle-dir"] && !values["compare-bundle-dir"]) {
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
  values["control-bundle-dir"],
].filter((directory): directory is string => Boolean(directory));
const servers: Array<{
  directory: string;
  build: { buildId: string; version: string };
  sha256: string;
  server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
}> = [];
const browsers = new Map<ControlUiEngine, Browser>();
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
  error?: string;
  errorEvents?: Array<{ message: string; phase: string }>;
  resizeErrorCount?: number;
  artifactPrefix: string;
};
const observations: Observation[] = [];
const writeJson = (name: string, value: unknown) =>
  writeFile(path.join(artifactDir, name), JSON.stringify(value, null, 2));
try {
  for (const directory of directories) {
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
      server: await startControlUiBenchGatewayServer(resolved),
    });
  }
  for (const engine of engines) {
    browsers.set(
      engine,
      await (engine === "webkit"
        ? webkitEngine.launch({ headless: true })
        : chromiumEngine.launch({
            headless: true,
            executablePath: resolvePlaywrightChromiumExecutablePath(
              chromiumEngine.executablePath(),
            ),
          })),
    );
  }
  const ids = values.steps?.split(",");
  const catalog: EngineScenario[] = [
    ...createEngineBootScenarios(servers[0]!.server.baseUrl),
    ...createEngineActionScenarios(),
    ...interactionScenarios.filter(
      (scenario) =>
        ids?.includes(scenario.id) ||
        (!scenario.explicitOnly &&
          !scenario.resourceOnly &&
          !scenario.projectionFamily &&
          !scenario.dataPage),
    ),
  ];
  const scenarios = catalog.filter(({ id, explicitOnly }) =>
    ids ? ids.includes(id) : !explicitOnly,
  );
  if (!scenarios.length || ids?.some((id) => !scenarios.some((scenario) => scenario.id === id))) {
    throw new Error("Unknown or empty --steps selection");
  }
  planned = scenarios.length * viewports.length * pairs * engines.length * servers.length;
  await writeJson("manifest.json", {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    browsers: Object.fromEntries(
      [...browsers].map(([engine, browser]) => [engine, browser.version()]),
    ),
    bundles: servers.map(({ directory, build, sha256 }) => ({ directory, build, sha256 })),
    host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, load: os.loadavg() },
    pairs,
    viewports,
    trace: values.trace,
    cpuOnly: values["cpu-only"],
    collection: values.trace
      ? "Playwright tracing and engine Inspector/Profiler; overhead included"
      : values["cpu-only"]
        ? "WebKit sampled process CPU and Chromium CDP thread CPU; no timeline or script profiler"
        : "Untraced wall time; Chromium CDP counters only, unavailable WebKit counters are null",
    order:
      "Serial engine and bundle order alternates each pair; fresh browser context per observation",
    acceptance:
      "Census ranks >1.5x WebKit/Chromium. Fix proof: ten interleaved pairs plus A/A control; median regression <=5% and p95 no worse, otherwise ten more pairs. Profile/CPU and structural counts decide on a noisy host; >20% attributable regression blocks.",
    boundary:
      "Production bundle and HTTP owner; synthetic Gateway. Cold means fresh context; warm means same-context document reload. Mock routing disables HTTP cache in both engines. Mobile transcript-top uses a native scrollport jump, not wheel input. No live Gateway/provider latency.",
    scenarios: scenarios.map(({ id, route, expected, navigation }) => ({
      id,
      route,
      expected,
      navigation,
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
            const context = await browsers.get(engine)!.newContext({
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
            try {
              await page.addInitScript("globalThis.__name = (fn) => fn");
              await page.addInitScript(installInteractionNavigationPreloadObserver);
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
              const fixture = createScenarioFixture(
                slot.build.buildId,
                slot.build.version,
                scenario,
              );
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
              observation.evidence = (await scenario.run(page, gateway)) ?? undefined;
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
                scenario.navigation ? 0 : before,
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
              await context.close();
              observations.push(observation);
              await writeJson(`${artifactPrefix}.json`, observation);
              await writeJson("observations.json", observations);
              console.log(JSON.stringify(observation));
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
for (const { viewport, step, engine, bundle } of observations) {
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
  ].join("\n"),
);
console.log(`Cross-engine artifacts: ${artifactDir}`);
if (observations.some(({ status }) => status === "failed")) {
  process.exitCode = 1;
}
