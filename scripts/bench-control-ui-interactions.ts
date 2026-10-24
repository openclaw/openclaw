import { execFileSync } from "node:child_process";
// Production-renderer warm interactions. Trace once for attribution; compare untraced AB pairs.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type CDPSession, type Page } from "playwright";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { mapColdLoadCpuProfile, summarizeCpuProfile } from "./lib/control-ui-cold-load-trace.ts";
import {
  createInteractionFixture,
  interactionScenarios,
} from "./lib/control-ui-interaction-scenarios.ts";
import {
  clipInteractionCpuProfile,
  summarizeInteractionTrace,
} from "./lib/control-ui-interaction-trace.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-interactions" },
    steps: { type: "string" },
    viewport: { type: "string", default: "both" },
    pairs: { type: "string", default: "1" },
    trace: { type: "boolean", default: false },
    "invalidation-tracking": { type: "boolean", default: false },
  },
});
const pairs = Number(values.pairs);
if (!Number.isInteger(pairs) || pairs < 1) {
  throw new Error("pairs must be a positive integer");
}
if (!["desktop", "mobile", "both"].includes(values.viewport)) {
  throw new Error("viewport must be desktop, mobile or both");
}
const selectedIds = values.steps?.split(",");
const scenarios = interactionScenarios.filter(
  (step) => !selectedIds || selectedIds.includes(step.id),
);
if (!scenarios.length || selectedIds?.some((id) => !scenarios.some((step) => step.id === id))) {
  throw new Error("Unknown or empty interaction steps");
}
const artifactDir = createControlUiE2eArtifactDir("warm", values.output);
const bundles = [values["bundle-dir"], values["compare-bundle-dir"]].filter(
  (directory): directory is string => Boolean(directory),
);
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

async function metrics(cdp: CDPSession) {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
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

type Result = {
  step: string;
  viewport: string;
  bundle: number;
  pair: number;
  status: "passed" | "failed";
  wallMs?: number;
  scriptMs?: number;
  taskMs?: number;
  layoutMs?: number;
  styleMs?: number;
  requests?: Record<string, number>;
  domBefore?: { nodes: number; menuItems: number };
  domAfter?: { nodes: number; menuItems: number };
  rowIdentity?: { initial: number; created: number; retained: number; final: number };
  trace?: ReturnType<typeof summarizeInteractionTrace>;
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
  server: Awaited<ReturnType<typeof startBuiltControlUiE2eServer>>;
}> = [];
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  headless: true,
});
try {
  for (const directory of bundles) {
    const resolved = path.resolve(directory);
    const html = await readFile(path.join(resolved, "index.html"), "utf8");
    const raw = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!raw) {
      throw new Error(`Missing build identity: ${directory}`);
    }
    const build: { buildId: string; version: string } = JSON.parse(raw);
    servers.push({
      directory: resolved,
      build,
      indexSha256: createHash("sha256").update(html).digest("hex"),
      server: await startBuiltControlUiE2eServer(resolved),
    });
  }
  await writeFile(
    path.join(artifactDir, "manifest.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        browser: browser.version(),
        host: {
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          load: os.loadavg(),
        },
        collection: values.trace
          ? "CDP trace + 1ms CPU profiler (overhead included)"
          : "untraced CDP metrics",
        invalidationTracking: values.trace && values["invalidation-tracking"],
        fixture: { sessions: 1000, messagesPerSession: 400, models: 1000, cronJobs: 500 },
        acceptance:
          "For fixed steps: >=10 serial AB pairs per viewport, all median/p95/min/max cells reviewed; any >20% regression stops landing. No boot growth beyond 64 B.",
        exclusions: [
          "No live Gateway/provider",
          "No sidebar text input exists; measure command palette search separately",
          "No fake clocks, Lit probes or simulated transport delay",
        ],
        scenarios: scenarios.map(({ id, route, expected }) => ({ id, route, expected })),
        viewports,
        bundles: servers.map(({ directory, build, indexSha256 }) => ({
          directory,
          ...build,
          indexSha256,
        })),
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
        for (const [bundle, slot] of servers.entries()) {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            serviceWorkers: "block",
          });
          const page = await context.newPage();
          page.setDefaultTimeout(15_000);
          // tsx preserves names in serialized fixture callbacks, as in the cold-load runner.
          await page.addInitScript("globalThis.__name = (fn) => fn");
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const artifactPrefix = `${viewport.name}-${scenario.id}-${pair + 1}-${bundle}`;
          const result: Result = {
            step: scenario.id,
            viewport: viewport.name,
            pair,
            bundle,
            status: "failed",
            artifactPrefix,
          };
          let cdp: CDPSession | undefined;
          let tracing = false;
          let profiling = false;
          const events: unknown[] = [];
          try {
            const fixture = createInteractionFixture(slot.build.buildId, slot.build.version);
            const sessions = createTeamScaleSidebarListOwner({
              rows: fixture.sessions,
              viewerProfileId: "interaction-viewer",
              now: 1_800_000_000_000,
              defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
              owners: [],
            });
            const gateway = await installMockGateway(page, fixture, {
              requestHandlers: {
                "sessions.list": (params) => {
                  if (!isRecord(params)) {
                    throw new Error("Expected sessions.list query parameters");
                  }
                  return sessions.list(params).result;
                },
              },
            });
            await page.goto(new URL(scenario.route, slot.server.baseUrl).href);
            await scenario.prepare(page, gateway);
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await settle(page);
            cdp = await context.newCDPSession(page);
            await cdp.send("Performance.enable");
            if (values.trace) {
              cdp.on("Tracing.dataCollected", ({ value }: { value: unknown[] }) =>
                events.push(...value),
              );
              await cdp.send("Tracing.start", {
                categories: [
                  "toplevel,blink.user_timing,devtools.timeline",
                  ...(values["invalidation-tracking"]
                    ? ["disabled-by-default-devtools.timeline.invalidationTracking"]
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
            const requestsBefore = (await gateway.getRequests()).length;
            const countDom = () =>
              page.evaluate(() => ({
                nodes: document.querySelectorAll("*").length,
                menuItems: document.querySelectorAll('[role^="menuitem"]').length,
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
            const before = await metrics(cdp);
            await page.evaluate(() => performance.mark("interaction:start"));
            const start = performance.now();
            await scenario.run(page, gateway);
            await settle(page);
            result.wallMs = performance.now() - start;
            await page.evaluate(() => performance.mark("interaction:end"));
            const after = await metrics(cdp);
            result.domAfter = await countDom();
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
            result.requests = {};
            for (const request of (await gateway.getRequests()).slice(requestsBefore)) {
              result.requests[request.method] = (result.requests[request.method] ?? 0) + 1;
            }
            if (errors.length) {
              throw new Error(errors.join("\n"));
            }
            result.status = "passed";
          } catch (error) {
            result.error = String(error);
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
                      await writeFile(
                        path.join(artifactDir, `${artifactPrefix}.hotspots.json`),
                        JSON.stringify(
                          {
                            mappedFrames: mapped.mappedFrames,
                            unmappedFrames: mapped.unmappedFrames,
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
              await capture(() =>
                page.screenshot({ path: path.join(artifactDir, `${artifactPrefix}.png`) }),
              );
            } finally {
              await capture(async () => cdp?.detach());
              await capture(() => context.close());
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
  for (const { server } of servers) {
    await server.close();
  }
}
const summary = viewports
  .flatMap(({ name }) =>
    scenarios.flatMap(({ id }) =>
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
          trace:
            values.trace && samples.length
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
            (["wallMs", "scriptMs", "taskMs", "layoutMs", "styleMs"] as const).map((metric) => [
              metric,
              samples.length ? distribution(samples.map((row) => row[metric]!)) : null,
            ]),
          ),
        };
      }),
    ),
  )
  .toSorted((a, b) => (b.metrics.scriptMs?.median ?? 0) - (a.metrics.scriptMs?.median ?? 0));
const comparisons = summary
  .filter((row) => row.bundle === 0)
  .flatMap((baseline) => {
    const candidate = summary.find(
      (row) => row.bundle === 1 && row.viewport === baseline.viewport && row.step === baseline.step,
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
await writeFile(
  path.join(artifactDir, "summary.json"),
  JSON.stringify(
    {
      comparisons,
      planned: viewports.length * scenarios.length * pairs * servers.length,
      executed: results.length,
      failed: results.filter((row) => row.status === "failed").length,
      skipped: 0,
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
          ...(values.trace && representative.trace
            ? ["trace.json", "hotspots.json", "cpuprofile"]
            : []),
        ]
          .map(
            (suffix) =>
              `<a href="${escapeHtml(representative.artifactPrefix)}.${suffix}">${suffix}</a>`,
          )
          .join(" ")
      : "";
    return `<tr><td>${escapeHtml(row.viewport)}</td><td>${escapeHtml(row.step)}</td><td>${row.bundle}</td><td>${row.passed}/${row.failed}</td><td>${metric("scriptMs")}</td><td>${metric("taskMs")}</td><td>${metric("layoutMs")}</td><td>${metric("styleMs")}</td><td>${row.trace?.longTasks?.median ?? "—"}</td><td>${links}</td></tr>`;
  })
  .join("\n");
await writeFile(
  path.join(artifactDir, "report.html"),
  `<!doctype html><meta charset="utf-8"><title>Warm interactions</title><style>body{font:15px system-ui;padding:24px}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #bbb;text-align:left}a{margin-right:6px}</style><h1>Production-renderer warm interactions</h1><p>${values.trace ? "Trace and CPU sampling overhead included." : "Untraced CDP metric deltas."} Cells: median / p95 / min–max (ms). Wall time in JSON is automation-to-assertion, not INP. Synthetic Gateway; native clocks. <a href="manifest.json">Manifest</a> <a href="summary.json">Summary</a></p><table><tr><th>Viewport</th><th>Step</th><th>Bundle</th><th>Pass/fail</th><th>Script</th><th>Task</th><th>Layout</th><th>Style</th><th>Long tasks</th><th>Evidence</th></tr>${rows}</table>`,
);
console.log(`Warm interaction artifacts: ${artifactDir}`);
if (results.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}
