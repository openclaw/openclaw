// Production plugin renderers with synthetic Gateway data. Build/snapshot assets separately.
// Example: node --import ./scripts/tsx.mjs scripts/bench-plugin-views.ts --plugin-root .artifacts/plugin-views/base --compare-plugin-root .artifacts/plugin-views/head --pairs 10
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { WorkboardLink } from "@openclaw/workboard-contract";
import { chromium, expect, type CDPSession, type Page } from "playwright/test";
import { controlUiPluginAssetPrefix } from "../src/gateway/control-ui-plugin-assets-contract.js";
import { readPluginControlUiAssets } from "../src/plugins/control-ui-assets.js";
import type { PluginManifestControlUi } from "../src/plugins/manifest-types.js";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
  startProductionControlUiE2eServer,
  type ControlUiMockGateway,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { buildWorkboardMocks } from "../ui/src/test-helpers/control-ui-workboard-fixtures.ts";
import { installWorkboardBoardMock } from "../ui/src/test-helpers/control-ui-workboard-mocks.ts";
import {
  mapColdLoadCpuProfile,
  summarizeCpuProfile,
  summarizeScriptCoverage,
} from "./lib/control-ui-cold-load-trace.ts";
import { summarizeInteractionTrace } from "./lib/control-ui-interaction-trace.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "plugin-root": { type: "string", default: "extensions" },
    "compare-plugin-root": { type: "string" },
    "build-host": { type: "boolean", default: false },
    plugins: { type: "string", default: "workboard,memory-core,nostr" },
    profiles: { type: "string", default: "local,remote" },
    pairs: { type: "string", default: "10" },
    "pair-offset": { type: "string", default: "0" },
    cards: { type: "string", default: "300" },
    "linked-dependencies": { type: "boolean", default: false },
    output: { type: "string", default: ".artifacts/plugin-views/measure" },
    trace: { type: "boolean", default: false },
    coverage: { type: "boolean", default: false },
    "thread-cpu-time": { type: "boolean", default: false },
    "loads-only": { type: "boolean", default: false },
  },
});
const pairs = Number(values.pairs);
const pairOffset = Number(values["pair-offset"]);
const cardCount = Number(values.cards);
const pluginIds = values.plugins.split(",");
const profiles = values.profiles.split(",");
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  !Number.isInteger(pairOffset) ||
  pairOffset < 0 ||
  !Number.isInteger(cardCount) ||
  cardCount < 6 ||
  pluginIds.some((id) => !["workboard", "memory-core", "nostr"].includes(id)) ||
  profiles.some((id) => !["local", "remote"].includes(id))
) {
  throw new Error(
    "Use positive --pairs, nonnegative --pair-offset, --cards >= 6, known --plugins and --profiles local,remote",
  );
}
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
type Metrics = Record<string, number>;
type Step = {
  id: string;
  wallMs: number;
  metrics: Metrics;
  longTasks: number[];
  requests: Record<string, number>;
  assets: string[];
  trace?: unknown;
  heapBytes: number;
  nodes: number;
  elements: number;
  menuElements: number;
};
type Sample = {
  plugin: string;
  profile: string;
  pair: number;
  variant: number;
  root: string;
  browserVersion: string;
  hostLoad: number[];
  status: "passed" | "failed";
  steps: Step[];
  error?: string;
  errors: string[];
  coverage?: unknown;
  warmCoverage?: unknown;
  menuReturnFocusAfterRowsChange?: boolean;
  dependencyChildRetainedAfterParentUpdate?: boolean;
  hostPrefetch?: unknown;
  workboardFixture?: {
    generatedAt: number;
    createdAt: number;
    updatedAt: number;
    initialAgeMs: number;
    expectedUpdatedText: string;
    coldObservedAt?: number;
    warmObservedAt?: number;
  };
  postGcMemory?: { heapBytes: number; nodes: number; elements: number; menuElements: number };
};
const results: Sample[] = [];
const roots = [values["plugin-root"], values["compare-plugin-root"]].filter(
  (root): root is string => Boolean(root),
);
const statuses = ["todo", "ready", "running", "review", "blocked", "done"];
const linkedDependencies = values["linked-dependencies"];
const rootCount = linkedDependencies ? Math.max(2, Math.ceil(cardCount / 10)) : 0;
const workboardInitialAgeMs = (2 * 24 + 3) * 60 * 60 * 1000;
function createWorkboardFixture(fixtureTime: number) {
  const seed = buildWorkboardMocks(fixtureTime, { id: "benchmark", label: "Benchmark" });
  const updatedAt = fixtureTime - workboardInitialAgeMs;
  const createdAt = updatedAt - 24 * 60 * 60 * 1000;
  const cardStatuses = Array.from(
    { length: cardCount },
    (_, index) => statuses[index % statuses.length]!,
  );
  const links: (WorkboardLink & { targetCardId: string })[][] = Array.from(
    { length: cardCount },
    () => [],
  );
  if (linkedDependencies) {
    // Its child with root zero clears when root zero finishes.
    cardStatuses[rootCount - 1] = "done";
    for (let child = rootCount; child < cardCount; child++) {
      const ordinal = child - rootCount;
      const parents = [ordinal % rootCount, (ordinal + 1) % rootCount];
      cardStatuses[child] = parents.every((parent) => cardStatuses[parent] === "done")
        ? "ready"
        : "todo";
      for (const parent of parents) {
        links[child]!.push({
          id: `dep-${child}-${parent}-parent`,
          type: "parent",
          targetCardId: `bench-${parent}`,
          createdAt: updatedAt,
        });
        links[parent]!.push({
          id: `dep-${child}-${parent}-child`,
          type: "child",
          targetCardId: `bench-${child}`,
          createdAt: updatedAt,
        });
      }
    }
  }
  const positions = new Map<string, number>();
  const cards = Array.from({ length: cardCount }, (_, index) => {
    const status = cardStatuses[index]!;
    const position = (positions.get(status) ?? 0) + 1000;
    positions.set(status, position);
    return {
      ...seed.cards[0]!,
      id: `bench-${index}`,
      title: `Benchmark card ${String(index).padStart(3, "0")}`,
      status,
      position,
      sessionKey: undefined,
      createdAt,
      updatedAt,
      priority: index % 2 ? "high" : "normal",
      labels: [index % 2 ? "review" : "engineering"],
      metadata: {
        automation: { boardId: "benchmark" },
        ...(linkedDependencies ? { links: links[index] } : {}),
      },
    };
  });
  if (linkedDependencies) {
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    for (const card of cards.slice(rootCount)) {
      const parents = card.metadata.links!.filter((link) => link.type === "parent");
      expect(parents).toHaveLength(2);
      expect(card.status).toBe(
        parents.every((parent) => cardsById.get(parent.targetCardId)?.status === "done")
          ? "ready"
          : "todo",
      );
    }
  }
  seed.cards = cards;
  seed.boards = [
    {
      ...seed.board,
      id: "benchmark",
      name: "Benchmark board",
      total: cardCount,
      active: cardCount,
      archived: 0,
      byStatus: Object.fromEntries(
        statuses.map((status) => [
          status,
          seed.cards.filter((card) => card.status === status).length,
        ]),
      ),
    },
  ];
  seed.methodResponses["workboard.cards.list"].cards = seed.cards;
  seed.methodResponses["workboard.cards.list"].boards = seed.boards;
  seed.methodResponses["workboard.boards.list"].boards = seed.boards;
  return seed;
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  const snapshot = Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
  for (const name of ["TaskOtherDuration", "V8CompileDuration", "DevToolsCommandDuration"]) {
    if (!Number.isFinite(snapshot[name])) {
      throw new Error(`Chromium Performance.getMetrics is missing a finite ${name}`);
    }
  }
  return snapshot;
}
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
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
async function loadPlugin(root: string, pluginId: string) {
  const rootDir = path.resolve(root, pluginId);
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "dist/openclaw.plugin.json"), "utf8"),
  ) as { controlUi: PluginManifestControlUi };
  const declaration = manifest.controlUi;
  const revision = path.basename(path.dirname(declaration.entry));
  const prefix = `${controlUiPluginAssetPrefix(pluginId)}${revision}/`;
  const generation = await readPluginControlUiAssets(rootDir, declaration);
  return {
    files: generation.assets,
    assets: new Map([...generation.assets].map(([name, asset]) => [`${prefix}${name}`, asset])),
    descriptor: {
      pluginId,
      name: pluginId,
      revision,
      entryUrl: `${prefix}${generation.entryName}`,
      styles: generation.styles.map((name) => `${prefix}${name}`),
    },
    bytes: generation.bytes,
    directory: path.join(rootDir, generation.directory),
    sha256: createHash("sha256")
      .update(
        [...generation.assets]
          .map(
            ([name, asset]) => `${name}:${createHash("sha256").update(asset.body).digest("hex")}`,
          )
          .join("\n"),
      )
      .digest("hex"),
  };
}

function scenario(
  plugin: string,
  descriptor: Awaited<ReturnType<typeof loadPlugin>>["descriptor"],
  build: { buildId: string; version: string },
  seed: ReturnType<typeof createWorkboardFixture>,
): ControlUiMockGatewayScenario {
  const common: ControlUiMockGatewayScenario = {
    serverBuildId: build.buildId,
    serverVersion: build.version,
    communityInvite: false,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "plugins.controlUi.list",
      "plugins.controlUi.report",
      "memory.search",
      "agents.workspace.get",
    ],
    methodResponses: {
      "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
      "plugins.controlUi.list": {
        plugins: plugin === "workboard" ? [descriptor] : [],
        diagnostics: [],
        revision: descriptor.revision,
      },
      "plugins.controlUi.report": { ok: true },
    },
  };
  if (plugin === "workboard") {
    return {
      ...common,
      controlUiTabs: [
        {
          pluginId: plugin,
          id: "workboard",
          label: "Workboard",
          placement: "route:workboard",
          icon: "kanban",
          group: "control",
        },
      ],
      methodResponses: { ...seed.methodResponses, ...common.methodResponses },
    };
  }
  if (plugin === "memory-core") {
    return {
      ...common,
      methodResponses: {
        ...common.methodResponses,
        "memory.search": {
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: Array.from({ length: 20 }, (_, index) => ({
            path: `memory/benchmark-${index}.md`,
            startLine: 1,
            endLine: 2,
            score: 1 - index / 100,
            source: "memory",
            snippet: `Benchmark memory ${index}: synthetic review notes.`,
          })),
        },
        "agents.workspace.get": {
          file: {
            encoding: "utf8",
            content: "Benchmark memory\nSynthetic review notes.\nAdditional detail.",
          },
        },
      },
    };
  }
  return {
    ...common,
    methodResponses: {
      ...common.methodResponses,
      "channels.status": {
        ts: 1,
        channelOrder: ["nostr"],
        channelLabels: { nostr: "Nostr" },
        channels: {
          nostr: {
            configured: true,
            running: true,
            publicKey: "npub1benchmark",
            profile: { name: "Benchmark" },
          },
        },
        channelAccounts: { nostr: [{ accountId: "benchmark", configured: true, running: true }] },
        channelDefaultAccountId: { nostr: "benchmark" },
      },
    },
  };
}

const bundles = await Promise.all(
  roots.map(async (root) => ({
    root,
    plugins: new Map(
      await Promise.all(
        pluginIds.map(async (plugin) => [plugin, await loadPlugin(root, plugin)] as const),
      ),
    ),
  })),
);
const server = values["build-host"]
  ? await startProductionControlUiE2eServer(path.resolve(values["bundle-dir"]), "plugin-benchmark")
  : await startBuiltControlUiE2eServer(path.resolve(values["bundle-dir"]));
const build = await (async () => {
  const html = await readFile(path.join(values["bundle-dir"], "index.html"), "utf8");
  const raw = html.match(/globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su)?.[1];
  if (!raw) {
    throw new Error("Built UI is missing its build identity");
  }
  return JSON.parse(raw) as { buildId: string; version: string };
})().catch(async (error: unknown) => {
  await server.close();
  throw error;
});
try {
  for (const profile of profiles) {
    for (let pair = pairOffset; pair < pairOffset + pairs; pair++) {
      for (const variant of pair % 2 ? [...bundles.keys()].toReversed() : bundles.keys()) {
        for (const plugin of pluginIds) {
          const bundle = bundles[variant]!;
          const asset = bundle.plugins.get(plugin)!;
          const prefix = `${plugin}-${profile}-${pair + 1}-${variant}`;
          // A fresh process keeps browser caches and renderer ownership out of AB order.
          const browser = await chromium.launch({
            executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
            headless: true,
          });
          const context = await browser.newContext({
            viewport: { width: 1440, height: 1000 },
            serviceWorkers: "block",
            locale: "en-US",
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          page.setDefaultTimeout(30_000);
          const cdp = await context.newCDPSession(page);
          const fixtureTime = Date.now();
          const seed = createWorkboardFixture(fixtureTime);
          const sample: Sample = {
            plugin,
            profile,
            pair: pair + 1,
            variant,
            root: bundle.root,
            browserVersion: browser.version(),
            hostLoad: os.loadavg(),
            status: "failed",
            steps: [],
            errors: [],
            ...(plugin === "workboard"
              ? {
                  workboardFixture: {
                    generatedAt: fixtureTime,
                    createdAt: seed.cards[0]!.createdAt,
                    updatedAt: seed.cards[0]!.updatedAt,
                    initialAgeMs: workboardInitialAgeMs,
                    expectedUpdatedText: "2d ago",
                  },
                }
              : {}),
          };
          page.on("pageerror", (error) => sample.errors.push(error.message));
          let navigationManifest:
            | Promise<{ url: string; entries: Record<string, string[]>; error?: string }>
            | undefined;
          const assets: string[] = [];
          page.on("response", (response) => {
            const pathname = new URL(response.url()).pathname;
            if (/\/navigation-preloads-[^/]+\.json$/u.test(pathname)) {
              navigationManifest = response
                .json()
                .then((entries) => ({
                  url: response.url(),
                  entries: entries as Record<string, string[]>,
                }))
                .catch((error: unknown) => ({
                  url: response.url(),
                  entries: {},
                  error: String(error),
                }));
            }
            if (/\.(?:js|css)$/u.test(pathname)) {
              assets.push(pathname);
            }
            if (response.status() >= 400) {
              sample.errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
            }
          });
          let tracing = false;
          const traceEvents: unknown[] = [];
          const marks: Array<{ id: string; start: string; end: string }> = [];
          try {
            await page.addInitScript("globalThis.__name = (fn) => fn");
            await page.addInitScript(() => {
              const settled = new WeakMap<HTMLLinkElement, string>();
              Object.assign(window, { pluginBenchmarkPreloadState: settled });
              for (const type of ["load", "error"] as const) {
                document.addEventListener(
                  type,
                  (event) => {
                    if (event.target instanceof HTMLLinkElement) {
                      settled.set(event.target, type);
                    }
                  },
                  true,
                );
              }
            });
            await page.addInitScript(() => {
              const state = { longTasks: [] as Array<{ start: number; duration: number }> };
              Object.assign(window, { pluginBenchmark: state });
              new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  state.longTasks.push({ start: entry.startTime, duration: entry.duration });
                }
              }).observe({ type: "longtask", buffered: true });
            });
            const gateway = await installMockGateway(
              page,
              scenario(plugin, asset.descriptor, build, seed),
            );
            if (plugin === "workboard") {
              await page.addInitScript(installWorkboardBoardMock, seed);
            }
            if (profile === "remote") {
              await page.addInitScript(() => {
                // The fixture transport has no network; add the full RTT at delivery.
                const prototype = WebSocket.prototype as WebSocket & {
                  deliver: (frame: unknown) => void;
                };
                const deliver = prototype.deliver;
                prototype.deliver = function (frame) {
                  setTimeout(() => deliver.call(this, frame), 100);
                };
              });
            }
            await page.route("**/__openclaw__/plugins/control-ui/**", async (route) => {
              const resource = asset.assets.get(new URL(route.request().url()).pathname);
              if (!resource) {
                return route.fulfill({ status: 404 });
              }
              if (profile === "remote") {
                await new Promise((resolve) => {
                  setTimeout(resolve, 100);
                });
              }
              return route.fulfill({ status: 200, ...resource });
            });
            await page.route(`**/assets/plugins/${plugin}/**`, async (route) => {
              const generationPath = new URL(route.request().url()).pathname.split(
                `/assets/plugins/${plugin}/`,
              )[1]!;
              const name = generationPath.slice(generationPath.indexOf("/") + 1);
              const resource = asset.files.get(name);
              if (!resource) {
                return route.fulfill({ status: 404 });
              }
              return route.fulfill({ status: 200, ...resource });
            });
            if (profile === "remote") {
              await page.route("**/*", async (route) => {
                if (!route.request().url().includes("/__openclaw__/plugins/control-ui/")) {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 100);
                  });
                }
                await route.fallback();
              });
            }
            await cdp.send("Performance.enable", {
              timeDomain: values["thread-cpu-time"] ? "threadTicks" : "timeTicks",
            });
            if (values.trace) {
              cdp.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
              await cdp.send("Tracing.start", {
                categories:
                  "devtools.timeline,blink.user_timing,v8,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack",
                transferMode: "ReportEvents",
              });
              tracing = true;
              await cdp.send("Profiler.enable");
              await cdp.send("Profiler.start");
            }
            const requestCounts = async () => {
              const requests = await gateway.getRequests();
              return requests.reduce<Record<string, number>>((counts, request) => {
                counts[request.method] = (counts[request.method] ?? 0) + 1;
                return counts;
              }, {});
            };
            const step = async (id: string, action: () => Promise<unknown>, navigation = false) => {
              const before = await metrics(cdp);
              const assetsBefore = assets.length;
              const requestsBefore = navigation ? {} : await requestCounts();
              const start = `${prefix}-${id}-start`,
                end = `${prefix}-${id}-end`;
              if (!navigation) {
                await page.evaluate((name) => performance.mark(name), start);
              }
              const started = performance.now();
              await action();
              await frames(page);
              const wallMs = performance.now() - started;
              await page.evaluate((name) => performance.mark(name), end);
              const after = await metrics(cdp);
              const requestsAfter = await requestCounts();
              const longTasks = await page.evaluate(
                ({ navigation: isNavigation, start: startMark }) => {
                  const state = (
                    window as Window & {
                      pluginBenchmark?: { longTasks: Array<{ start: number; duration: number }> };
                    }
                  ).pluginBenchmark;
                  const boundary = isNavigation
                    ? 0
                    : (performance.getEntriesByName(startMark)[0]?.startTime ?? 0);
                  return (
                    state?.longTasks
                      .filter((entry) => entry.start >= boundary)
                      .map((entry) => entry.duration) ?? []
                  );
                },
                { navigation, start },
              );
              const measured: Step = {
                id,
                wallMs,
                metrics: Object.fromEntries(
                  [
                    "TaskDuration",
                    "ScriptDuration",
                    "TaskOtherDuration",
                    "V8CompileDuration",
                    "DevToolsCommandDuration",
                    "LayoutDuration",
                    "RecalcStyleDuration",
                    "LayoutCount",
                    "RecalcStyleCount",
                  ].map((name) => [
                    name,
                    ((after[name] ?? 0) - (navigation ? 0 : (before[name] ?? 0))) *
                      (name.endsWith("Duration") ? 1000 : 1),
                  ]),
                ),
                longTasks,
                requests: Object.fromEntries(
                  Object.entries(requestsAfter)
                    .map(([name, count]) => [name, count - (requestsBefore[name] ?? 0)])
                    .filter(([, count]) => count),
                ),
                assets: assets.slice(assetsBefore),
                heapBytes: after.JSHeapUsedSize ?? 0,
                nodes: after.Nodes ?? 0,
                ...(await page.evaluate(() => ({
                  elements: document.getElementsByTagName("*").length,
                  menuElements: document.querySelectorAll(".workboard-card__action-menu-panel *")
                    .length,
                }))),
              };
              sample.steps.push(measured);
              if (!navigation) {
                marks.push({ id, start, end });
              }
              if (pair === 0) {
                await page.screenshot({ path: path.join(output, `${prefix}-${id}.png`) });
              }
            };
            const route =
              plugin === "workboard"
                ? "workboard/benchmark"
                : plugin === "memory-core"
                  ? "settings/memory/memories"
                  : "settings/channels";
            const ready = async () => {
              if (plugin === "workboard") {
                await expect(page.locator(".workboard-card")).toHaveCount(cardCount);
                await expect(page.locator(".workboard-create")).toBeEnabled();
                await expect(page.locator(".workboard-card__menu-trigger")).toHaveCount(cardCount);
                await expect(page.locator(".workboard-card__menu-trigger").nth(1)).toBeVisible();
                await expect(
                  page.locator('[data-card-id="bench-0"] .workboard-card__updated'),
                ).toHaveText("2d ago");
              } else if (plugin === "memory-core") {
                await expect(
                  page.getByRole("searchbox", { name: "Search memories" }),
                ).toBeVisible();
              } else {
                await page
                  .locator("button.channels-item, button.channels-item__detail")
                  .filter({ hasText: "Nostr" })
                  .first()
                  .click();
                await expect(
                  page.getByRole("button", { name: "Edit Profile", exact: true }),
                ).toBeVisible();
              }
            };
            const stopCoverage = async (phase: "cold" | "warm") => {
              const entries = await page.coverage.stopJSCoverage();
              const pluginEntries = entries.filter(
                (entry) =>
                  entry.url.includes(`/plugins/control-ui/${plugin}/`) ||
                  entry.url.includes(`/assets/plugins/${plugin}/`),
              );
              await writeFile(
                path.join(output, `${prefix}${phase === "warm" ? "-warm" : ""}-coverage.json`),
                JSON.stringify(pluginEntries),
              );
              const scripts = pluginEntries.map((entry) =>
                Object.assign({ url: new URL(entry.url).pathname }, summarizeScriptCoverage(entry)),
              );
              return {
                scripts,
                ...scripts.reduce(
                  (total, row) => ({
                    loadedBytes: total.loadedBytes + row.loadedBytes,
                    executedBytes: total.executedBytes + row.executedBytes,
                    unusedBytes: total.unusedBytes + row.unusedBytes,
                  }),
                  { loadedBytes: 0, executedBytes: 0, unusedBytes: 0 },
                ),
              };
            };
            if (values.coverage) {
              await page.coverage.startJSCoverage({ resetOnNavigation: true });
            }
            await step(
              "cold-load",
              async () => {
                await page.goto(new URL(route, server.baseUrl).href);
                await ready();
              },
              true,
            );
            if (sample.workboardFixture) {
              sample.workboardFixture.coldObservedAt = Date.now();
            }
            if (values.coverage) {
              sample.coverage = await stopCoverage("cold");
            }
            const navigate = async (pathname: string) => {
              await page.evaluate((next) => {
                history.pushState(null, "", next);
                window.dispatchEvent(new PopStateEvent("popstate"));
              }, pathname);
            };
            // Let native prefetch finish before New Session can remove itself from pending.
            await expect.poll(() => navigationManifest !== undefined).toBe(true);
            const manifest = await navigationManifest!;
            if (manifest.error) {
              throw new Error(`Navigation prefetch descriptor failed: ${manifest.error}`);
            }
            const routePreloads = manifest.entries["new-session"];
            if (!routePreloads?.length) {
              throw new Error("Navigation prefetch descriptor has no New Session assets");
            }
            const preloadHrefs = routePreloads.map(
              (file) => new URL(file, new URL("../", manifest.url)).href,
            );
            await frames(page);
            await page.waitForFunction((hrefs) => {
              const settled = (
                window as Window & {
                  pluginBenchmarkPreloadState?: WeakMap<HTMLLinkElement, string>;
                }
              ).pluginBenchmarkPreloadState;
              const links = Array.from(
                document.querySelectorAll<HTMLLinkElement>(
                  'link[rel="preload"], link[rel="modulepreload"]',
                ),
              ).filter((link) => hrefs.includes(link.href));
              if (links.some((link) => settled?.get(link) === "error")) {
                throw new Error("An admitted navigation preload failed");
              }
              return hrefs.every((href) => {
                const matching = links.filter((link) => link.href === href);
                if (matching.length) {
                  return matching.every((link) => settled?.get(link) === "load");
                }
                return performance
                  .getEntriesByName(href, "resource")
                  .some((entry) => (entry as PerformanceResourceTiming).responseEnd > 0);
              });
            }, preloadHrefs);
            await frames(page);
            sample.hostPrefetch = await page.evaluate(
              ({ hrefs, descriptor }) => ({
                descriptor,
                expectedAssets: hrefs.length,
                admittedLinks: Array.from(
                  document.querySelectorAll<HTMLLinkElement>(
                    'link[rel="preload"], link[rel="modulepreload"]',
                  ),
                )
                  .filter((link) => hrefs.includes(link.href))
                  .map((link) => link.href),
                completedResources: hrefs.filter((href) =>
                  performance
                    .getEntriesByName(href, "resource")
                    .some((entry) => (entry as PerformanceResourceTiming).responseEnd > 0),
                ),
                settledAtMs: performance.now(),
              }),
              { hrefs: preloadHrefs, descriptor: manifest.url },
            );
            await navigate("/new");
            await expect(
              page.locator(".workboard-board--page, .memory-memories, openclaw-channels-page"),
            ).toHaveCount(0);
            await expect(page.locator(".new-session-page__message")).toBeVisible();
            await expect(page.locator(".new-session-page__message")).toBeEditable();
            await page.waitForFunction(() => {
              const readiness = window.openclawControlUi?.snapshot();
              return (
                readiness?.ready &&
                readiness.route?.matches.some((match) => match.routeId === "new-session")
              );
            });
            // Finish the warm-up route's admitted lazy renderer before measuring the remount.
            await expect(
              page.locator("openclaw-new-session-page openclaw-lobster-pet"),
            ).toHaveCount(1);
            await frames(page);
            if (values.coverage) {
              await page.coverage.startJSCoverage({ resetOnNavigation: false });
            }
            await step("warm-route-load", async () => {
              await navigate(`/${route}`);
              await ready();
            });
            if (sample.workboardFixture) {
              sample.workboardFixture.warmObservedAt = Date.now();
            }
            if (values.coverage) {
              sample.warmCoverage = await stopCoverage("warm");
            }
            if (plugin === "workboard" && !values["loads-only"]) {
              const menuTrigger = page.locator(".workboard-card__menu-trigger").nth(1);
              await menuTrigger.focus();
              await step("open-menu", async () => {
                await menuTrigger.press("Enter");
                await expect(
                  page.locator(
                    '.workboard-card__action-menu-panel:popover-open [aria-label="View details"]',
                  ),
                ).toBeVisible();
              });
              await page.keyboard.press("Escape");
              await expect(menuTrigger).toBeFocused();
              await step("search", async () => {
                await page.getByRole("button", { name: "Search cards", exact: true }).click();
                await page
                  .getByRole("searchbox", { name: "Search cards" })
                  .fill("Benchmark card 000");
                await expect(page.locator(".workboard-card")).toHaveCount(1);
              });
              await step("clear-search", async () => {
                await page.getByRole("searchbox", { name: "Search cards" }).fill("");
                await expect(page.locator(".workboard-card")).toHaveCount(cardCount);
              });
              await page.getByRole("button", { name: "Filters", exact: true }).click();
              await step("filter-priority", async () => {
                await page
                  .locator(
                    '.workboard-filter-section__options[aria-label="Priority"] label[title="High"] input',
                  )
                  .check();
                await expect(page.locator(".workboard-card")).toHaveCount(
                  Math.floor(cardCount / 2),
                );
              });
              await page.getByRole("button", { name: "Clear filters", exact: true }).click();
              await expect(page.locator(".workboard-card")).toHaveCount(cardCount);
              await page.keyboard.press("Escape");
              await step("select", async () => {
                await page
                  .locator(".workboard-card")
                  .first()
                  .click({ modifiers: ["Shift"] });
                await expect(page.locator(".workboard-card--selected")).toHaveCount(1);
              });
              await page.locator(".workboard-card--selected").click({ modifiers: ["Shift"] });
              await step("scroll", async () => {
                const cards = page.locator(".workboard-column__cards").first();
                const before = await cards.evaluate((element) => element.scrollTop);
                await cards.hover();
                await page.mouse.wheel(0, 1000);
                await expect
                  .poll(() => cards.evaluate((element) => element.scrollTop))
                  .toBeGreaterThan(before);
              });
              await step("open-card", async () => {
                const card = linkedDependencies
                  ? page.locator(
                      `.workboard-column__item[data-card-id="bench-${rootCount}"] .workboard-card`,
                    )
                  : page.locator(".workboard-card").first();
                await card.click();
                await expect(page.locator(".workboard-detail")).toBeVisible();
                if (linkedDependencies) {
                  const dependencies = page.locator(".workboard-detail__dependencies li");
                  await expect(dependencies).toHaveCount(2);
                  await expect(dependencies.nth(0)).toContainText("Benchmark card 000");
                  await expect(dependencies.nth(1)).toContainText("Benchmark card 001");
                }
              });
              await page.keyboard.press("Escape");
              const source = page
                .locator(".workboard-column")
                .nth(0)
                .locator(".workboard-card")
                .first();
              const target = page.locator(".workboard-column").nth(1);
              const sourceTitle = await source.locator("h3").textContent();
              if (!sourceTitle) {
                throw new Error("Benchmark card is missing its unique title");
              }
              let acknowledgedMove:
                | Pick<(typeof seed.cards)[number], "id" | "status" | "position">
                | undefined;
              await step("drag-reorder", async () => {
                const before = (await gateway.getRequests("workboard.cards.move")).length;
                await source.dragTo(target);
                const request = await gateway.waitForRequest("workboard.cards.move", {
                  after: before,
                });
                const { id, status, position } = request.params as NonNullable<
                  typeof acknowledgedMove
                >;
                acknowledgedMove = { id, status, position };
                await expect(
                  target
                    .locator(".workboard-card")
                    .getByRole("heading", { name: sourceTitle, exact: true }),
                ).toHaveCount(1);
              });
              expect(acknowledgedMove).toMatchObject({
                id: "bench-0",
                status: "ready",
                position: expect.any(Number),
              });
              const dependencyChild = linkedDependencies
                ? page.locator(
                    `.workboard-column__item[data-card-id="bench-${rootCount * 2 - 1}"] .workboard-card`,
                  )
                : undefined;
              if (dependencyChild) {
                await dependencyChild.scrollIntoViewIfNeeded();
                await expect(dependencyChild.locator(".workboard-card__alert")).toHaveText(
                  "1 blocked",
                );
              }
              const retainedChild = await dependencyChild?.elementHandle();
              await step("live-update", async () => {
                const updatedAt = Date.now() + 10_000;
                const card = {
                  ...seed.cards[0]!,
                  ...acknowledgedMove,
                  title: "Live benchmark update",
                  updatedAt,
                  ...(linkedDependencies ? { status: "done", completedAt: updatedAt } : {}),
                };
                const cards = [card, ...seed.cards.slice(1)];
                const boards = seed.boards.map((board) =>
                  Object.assign({}, board, {
                    byStatus: Object.fromEntries(
                      statuses.map((status) => [
                        status,
                        cards.filter((entry) => entry.status === status).length,
                      ]),
                    ),
                    updatedAt,
                  }),
                );
                await page.evaluate(
                  (payload) => {
                    const browserGateway = (
                      window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway }
                    ).openclawControlUiE2eGateway;
                    if (!browserGateway) {
                      throw new Error("Missing synthetic Gateway");
                    }
                    browserGateway.setRequestHandler("workboard.cards.list", ({ respond }) =>
                      respond(payload),
                    );
                  },
                  { statuses, cards, boards },
                );
                await gateway.emitGatewayEvent("plugin.workboard.changed", {
                  epoch: "benchmark-live",
                  revision: 1,
                });
                await expect(
                  page.locator('.workboard-column__item[data-card-id="bench-0"] h3'),
                ).toHaveText("Live benchmark update");
                if (dependencyChild) {
                  await expect(dependencyChild.locator(".workboard-card__alert")).toHaveCount(0);
                }
              });
              if (dependencyChild) {
                expect(retainedChild).not.toBeNull();
                expect(
                  await dependencyChild.evaluate(
                    (element, retained) => element === retained,
                    retainedChild,
                  ),
                ).toBe(true);
                sample.dependencyChildRetainedAfterParentUpdate = true;
              }
            } else if (plugin === "memory-core" && !values["loads-only"]) {
              await step("search-20", async () => {
                await page.getByRole("searchbox", { name: "Search memories" }).fill("Benchmark");
                await page.getByRole("button", { name: "Search", exact: true }).click();
                await expect(page.locator(".memory-memories article")).toHaveCount(20);
              });
              await step("expand", async () => {
                await page.locator(".memory-memories article > button").first().click();
                await expect(page.locator("[data-memory-match]")).toBeVisible();
              });
              await step("scroll", async () => {
                const last = page.locator(".memory-memories article").last();
                await last.scrollIntoViewIfNeeded();
                await expect(last).toBeInViewport();
              });
            } else if (!values["loads-only"]) {
              await page.locator(".channels-detail__close").click();
              await step("open-settings", async () => {
                await page
                  .locator("button.channels-item, button.channels-item__detail")
                  .filter({ hasText: "Nostr" })
                  .first()
                  .click();
                await expect(
                  page.getByRole("button", { name: "Edit Profile", exact: true }),
                ).toBeVisible();
              });
              await step("edit-profile", async () => {
                await page.getByRole("button", { name: "Edit Profile", exact: true }).click();
                await page.locator("#nostr-profile-name").fill("Benchmark Updated");
                await expect(page.locator("#nostr-profile-name")).toHaveValue("Benchmark Updated");
              });
            }
            if (plugin === "workboard" && !values["loads-only"]) {
              const updatedTrigger = page
                .locator(".workboard-card")
                .filter({
                  has: page.getByRole("heading", { name: "Live benchmark update", exact: true }),
                })
                .locator(".workboard-card__menu-trigger");
              await updatedTrigger.focus();
              await updatedTrigger.press("Enter");
              await expect(
                page.locator(".workboard-card__action-menu-panel:popover-open"),
              ).toBeVisible();
              await page.keyboard.press("Escape");
              await expect(updatedTrigger).toBeFocused();
              sample.menuReturnFocusAfterRowsChange = true;
            }
            if (sample.errors.length) {
              throw new Error(sample.errors.join("\n"));
            }
            sample.status = "passed";
          } catch (error) {
            sample.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
            const failureManifest = navigationManifest ? await navigationManifest : undefined;
            const failureHrefs = (failureManifest?.entries["new-session"] ?? []).map(
              (file) => new URL(file, new URL("../", failureManifest!.url)).href,
            );
            Object.assign(sample, {
              failureSetup: await page
                .evaluate((hrefs) => {
                  const settled = (
                    window as Window & {
                      pluginBenchmarkPreloadState?: WeakMap<HTMLLinkElement, string>;
                    }
                  ).pluginBenchmarkPreloadState;
                  const links = Array.from(document.querySelectorAll<HTMLLinkElement>("link")).map(
                    (link) => ({
                      href: link.href,
                      rel: link.rel,
                      state: settled?.get(link) ?? "none",
                    }),
                  );
                  const completedResources = performance
                    .getEntriesByType("resource")
                    .map((entry) => ({
                      name: entry.name,
                      responseEnd: (entry as PerformanceResourceTiming).responseEnd,
                    }));
                  const readiness = window.openclawControlUi?.snapshot();
                  return {
                    url: location.href,
                    readiness,
                    expectedHrefs: hrefs,
                    links,
                    completedResources,
                    pendingExpectedHrefs: hrefs.filter((href) => {
                      const matching = links.filter((link) => link.href === href);
                      return matching.length
                        ? matching.some((link) => link.state !== "load")
                        : !completedResources.some(
                            (entry) => entry.name === href && entry.responseEnd > 0,
                          );
                    }),
                  };
                }, failureHrefs)
                .catch((diagnosticError: unknown) => ({ error: String(diagnosticError) })),
            });
            await page
              .screenshot({ path: path.join(output, `${prefix}-failure.png`) })
              .catch(() => undefined);
          } finally {
            try {
              if (tracing) {
                const { profile: cpuProfile } = await cdp.send("Profiler.stop");
                await writeFile(
                  path.join(output, `${prefix}.cpuprofile`),
                  JSON.stringify(cpuProfile),
                );
                const pluginFrame =
                  cpuProfile.nodes.find(
                    (node: { callFrame: { url: string } }) =>
                      node.callFrame.url.includes(`/plugins/control-ui/${plugin}/`) ||
                      node.callFrame.url.includes(`/assets/plugins/${plugin}/`),
                  )?.callFrame.url ?? asset.descriptor.entryUrl;
                const mapped = await mapColdLoadCpuProfile(cpuProfile, {
                  assetBaseUrl: new URL(".", new URL(pluginFrame, server.baseUrl)).href,
                  assetDirectory: asset.directory,
                });
                await writeFile(
                  path.join(output, `${prefix}-cpu.json`),
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
                const complete = new Promise<void>((resolve) => {
                  cdp.once("Tracing.tracingComplete", () => resolve());
                });
                await cdp.send("Tracing.end");
                await complete;
                await writeFile(
                  path.join(output, `${prefix}-trace.json`),
                  JSON.stringify({ traceEvents }),
                );
                for (const mark of marks) {
                  const found = sample.steps.find((step) => step.id === mark.id);
                  if (found) {
                    found.trace = summarizeInteractionTrace(traceEvents, mark);
                  }
                }
                await cdp.send("HeapProfiler.collectGarbage");
                const afterGc = await metrics(cdp);
                sample.postGcMemory = {
                  heapBytes: afterGc.JSHeapUsedSize ?? 0,
                  nodes: afterGc.Nodes ?? 0,
                  ...(await page.evaluate(() => ({
                    elements: document.getElementsByTagName("*").length,
                    menuElements: document.querySelectorAll(".workboard-card__action-menu-panel *")
                      .length,
                  }))),
                };
              }
            } catch (error) {
              sample.status = "failed";
              sample.error = `${sample.error ?? ""}\nCapture: ${String(error)}`.trim();
            }
            if (sample.status === "passed" && sample.errors.length) {
              sample.status = "failed";
              sample.error = sample.errors.join("\n");
            }
            results.push(sample);
            await writeFile(path.join(output, "samples.json"), JSON.stringify(results, null, 2));
            console.log(
              JSON.stringify({
                plugin,
                profile,
                pair: pair + 1,
                variant,
                status: sample.status,
                error: sample.error,
              }),
            );
            await cdp.detach();
            await context.close();
            await browser.close();
          }
        }
      }
    }
  }
} finally {
  await server.close();
}
const summary = [];
const comparisonPairs = [];
for (const plugin of pluginIds) {
  for (const profile of profiles) {
    const cellSamples = results.filter(
      (sample) => sample.plugin === plugin && sample.profile === profile,
    );
    const pairOutcomes = Array.from({ length: pairs }, (_, index) => {
      const pair = pairOffset + index + 1;
      const missingVariants = [...bundles.keys()].filter(
        (variant) =>
          !cellSamples.some((sample) => sample.pair === pair && sample.variant === variant),
      );
      const failedVariants = cellSamples
        .filter((sample) => sample.pair === pair && sample.status !== "passed")
        .map((sample) => sample.variant);
      return {
        pair,
        included: missingVariants.length === 0 && failedVariants.length === 0,
        missingVariants,
        failedVariants,
      };
    });
    comparisonPairs.push({ plugin, profile, pairs: pairOutcomes });
    const includedPairs = new Set(
      pairOutcomes.filter((pair) => pair.included).map((pair) => pair.pair),
    );
    for (const variant of bundles.keys()) {
      const samples = cellSamples.filter(
        (sample) => sample.variant === variant && includedPairs.has(sample.pair),
      );
      for (const id of new Set(samples.flatMap((sample) => sample.steps.map((step) => step.id)))) {
        const steps = samples.flatMap((sample) => sample.steps.filter((step) => step.id === id));
        summary.push({
          plugin,
          profile,
          variant,
          step: id,
          n: steps.length,
          wallMs: distribution(steps.map((step) => step.wallMs)),
          metrics: Object.fromEntries(
            Object.keys(steps[0]!.metrics).map((name) => [
              name,
              distribution(steps.map((step) => step.metrics[name]!)),
            ]),
          ),
          longestTaskMs: distribution(steps.map((step) => Math.max(0, ...step.longTasks))),
          heapBytes: distribution(steps.map((step) => step.heapBytes)),
          nodes: distribution(steps.map((step) => step.nodes)),
          elements: distribution(steps.map((step) => step.elements)),
          menuElements: distribution(steps.map((step) => step.menuElements)),
          assetRequests: distribution(steps.map((step) => step.assets.length)),
        });
      }
    }
  }
}
await writeFile(
  path.join(output, "summary.json"),
  JSON.stringify(
    {
      workload: {
        cards: cardCount,
        linkedDependencies,
        dependencyRoots: rootCount,
        dependencyChildren: linkedDependencies ? cardCount - rootCount : 0,
        dependencyParentLinks: linkedDependencies ? (cardCount - rootCount) * 2 : 0,
        dependencyChildLinks: linkedDependencies ? (cardCount - rootCount) * 2 : 0,
        memoryResults: 20,
        nostr: "settings/profile; no feed renderer exists",
      },
      build,
      viewport: { width: 1440, height: 1000 },
      host: { platform: os.platform(), arch: os.arch(), cpuCount: os.cpus().length },
      attempts: {
        planned: profiles.length * pairs * bundles.length * pluginIds.length,
        completed: results.length,
        passed: results.filter((result) => result.status === "passed").length,
        failed: results.filter((result) => result.status === "failed").length,
      },
      variants: bundles.map((bundle) => ({
        root: bundle.root,
        plugins: Object.fromEntries(
          [...bundle.plugins].map(([id, plugin]) => [
            id,
            { bytes: plugin.bytes, sha256: plugin.sha256 },
          ]),
        ),
      })),
      instrumentation: {
        trace: values.trace,
        coverage: values.coverage,
        timeDomain: values["thread-cpu-time"] ? "threadTicks" : "timeTicks",
        loadsOnly: values["loads-only"],
        pairOffset,
        remote: "100ms delay per HTTP request and synthetic WebSocket response/event delivery",
        warm: "In-document route remount with resident modules; request routing disables HTTP cache",
      },
      comparisonPairs,
      summary,
    },
    null,
    2,
  ),
);
if (results.some((sample) => sample.status === "failed")) {
  process.exitCode = 1;
}
