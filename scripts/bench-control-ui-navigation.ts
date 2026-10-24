// Production-bundle navigation benchmark. Native HTTP cache, clocks, rendering and input.
// Example: node --import ./scripts/tsx.mjs scripts/bench-control-ui-navigation.ts \
//   --bundle-dir <base> --compare-bundle-dir <head> --pairs 10 --output <proof-dir>
// --trace adds timeline capture and exact input-to-ready thread CPU; no sampling profiler.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type CDPSession, type Locator, type Page } from "playwright";
import { selectControlUiRoutePreloads } from "../src/gateway/control-ui-route-preloads.ts";
import { createEmptyCostUsageTotals } from "../src/infra/session-cost-usage-totals.ts";
import type { SessionsUsageResult } from "../src/shared/usage-types.ts";
import { SIDEBAR_NAV_ROUTES } from "../ui/src/app-navigation.ts";
import type { RouteId } from "../ui/src/app-route-paths.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiSessionPath,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  defaultControlUiFeatureMethods,
  resolvePlaywrightChromiumExecutablePath,
  startBuiltControlUiE2eServer,
  waitForControlUiRoute,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createInteractionFixture } from "./lib/control-ui-interaction-scenarios.ts";
import { summarizeInteractionTrace } from "./lib/control-ui-interaction-trace.ts";
import {
  emulateNavigationWorkerNetwork,
  type NavigationWorkerRequest,
} from "./lib/control-ui-navigation-network.ts";

function summarizeMarkedThreadCpu(rawEvents: readonly unknown[]) {
  const records = rawEvents.map(asRecord).filter((event) => event !== null && event !== undefined);
  const boundary = (name: string) => {
    const matches = records.filter((event) => event.name === name);
    if (matches.length !== 1) {
      throw new Error(`Thread CPU needs exactly one marker: ${name}`);
    }
    const mark = matches[0]!;
    const { ts, tts, pid, tid } = mark;
    if (
      typeof ts !== "number" ||
      !Number.isFinite(ts) ||
      typeof tts !== "number" ||
      !Number.isFinite(tts) ||
      typeof pid !== "number" ||
      !Number.isFinite(pid) ||
      typeof tid !== "number" ||
      !Number.isFinite(tid)
    ) {
      throw new Error(`Thread CPU marker lacks finite ts/tts/pid/tid: ${name}`);
    }
    return { ts, tts, pid, tid };
  };
  const start = boundary("navigation:start");
  const end = boundary("navigation:end");
  if (start.pid !== end.pid || start.tid !== end.tid || end.ts <= start.ts || end.tts < start.tts) {
    throw new Error("Thread CPU markers must be ordered on the same renderer thread");
  }
  const captured = records.flatMap((event) => {
    if (event.pid !== start.pid || event.tid !== start.tid) {
      return [];
    }
    const { ts, tts, dur, tdur } = event;
    if (
      typeof ts !== "number" ||
      !Number.isFinite(ts) ||
      typeof tts !== "number" ||
      !Number.isFinite(tts)
    ) {
      return [];
    }
    const wallDuration = typeof dur === "number" && Number.isFinite(dur) && dur >= 0 ? dur : 0;
    const cpuDuration = typeof tdur === "number" && Number.isFinite(tdur) && tdur >= 0 ? tdur : 0;
    return [
      { wallUs: ts, cpuUs: tts },
      { wallUs: ts + wallDuration, cpuUs: tts + cpuDuration },
    ];
  });
  const bounds = captured.reduce(
    (region, point) => ({
      firstCpuUs: Math.min(region.firstCpuUs, point.cpuUs),
      lastCpuUs: Math.max(region.lastCpuUs, point.cpuUs),
      firstWallUs: Math.min(region.firstWallUs, point.wallUs),
      lastWallUs: Math.max(region.lastWallUs, point.wallUs),
    }),
    { firstCpuUs: Infinity, lastCpuUs: -Infinity, firstWallUs: Infinity, lastWallUs: -Infinity },
  );
  const { firstCpuUs, lastCpuUs, firstWallUs, lastWallUs } = bounds;
  if (firstCpuUs > start.tts || lastCpuUs < end.tts) {
    throw new Error("Captured thread CPU does not contain the marked interval");
  }
  return {
    rendererPid: start.pid,
    rendererTid: start.tid,
    start,
    end,
    threadCpuMs: (end.tts - start.tts) / 1000,
    capturedBeforeCpuMs: (start.tts - firstCpuUs) / 1000,
    capturedAfterCpuMs: (lastCpuUs - end.tts) / 1000,
    capturedTotalCpuMs: (lastCpuUs - firstCpuUs) / 1000,
    capturedBeforeWallMs: (start.ts - firstWallUs) / 1000,
    capturedAfterWallMs: (lastWallUs - end.ts) / 1000,
    note: "Captured pre/post regions include benchmark setup/actionability and observation; only navigation markers bound product input-to-ready. CPU is a thread-clock difference, not nested event-duration sums.",
  };
}

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-navigation" },
    pairs: { type: "string", default: "10" },
    scenarios: { type: "string" },
    profiles: { type: "string", default: "local,remote" },
    "idle-ms": { type: "string", default: "1500" },
    intent: { type: "string", default: "none" },
    "intent-ms": { type: "string", default: "150" },
    aa: { type: "boolean", default: false },
    "boot-only": { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    screenshots: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Navigation benchmark: --bundle-dir BASE [--compare-bundle-dir HEAD | --aa] --pairs 10 --profiles local,remote --scenarios usage,cron,command-palette --idle-ms 1500 --intent none|hover|focus --intent-ms 150 [--boot-only] [--trace] [--screenshots] --output DIR",
  );
  process.exit(0);
}
const pairs = Number(values.pairs);
const idleMs = Number(values["idle-ms"]);
const intentMs = Number(values["intent-ms"]);
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(idleMs) ||
  idleMs < 0 ||
  !Number.isFinite(intentMs) ||
  intentMs < 0
) {
  throw new Error("pairs must be a positive integer; delays must be nonnegative milliseconds");
}
if (!["none", "hover", "focus"].includes(values.intent)) {
  throw new Error("intent must be none, hover or focus");
}
if (values.aa && values["compare-bundle-dir"]) {
  throw new Error("--aa and --compare-bundle-dir are mutually exclusive");
}
const profiles = [
  { id: "local", latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  {
    id: "remote",
    latency: 100,
    downloadThroughput: 10_000_000 / 8,
    uploadThroughput: 10_000_000 / 8,
  },
].filter((profile) => values.profiles.split(",").includes(profile.id));
if (
  !profiles.length ||
  values.profiles.split(",").some((id) => !profiles.some((profile) => profile.id === id))
) {
  throw new Error("profiles must contain local and/or remote");
}
type Scenario = {
  id: string;
  routeId?: RouteId;
  selector: string;
  shortcut?: string;
  trigger?: string;
};
const allScenarios: Scenario[] = [
  ...SIDEBAR_NAV_ROUTES.map((routeId) => ({
    id: routeId,
    routeId,
    selector:
      routeId === "claws"
        ? ".claws-catalog-header"
        : routeId === "activity"
          ? "openclaw-activity-page .content-header"
          : routeId === "dashboards"
            ? "openclaw-dashboards-page .dashboard-preview openclaw-board-document .board-document__content"
            : `openclaw-${routeId}-page`,
  })),
  {
    id: "new-session",
    routeId: "new-session",
    selector: "openclaw-new-session-page .new-session-page__message",
  },
  {
    id: "appearance",
    routeId: "appearance",
    selector: "openclaw-config-page .settings-theme-grid [data-theme-id]",
    shortcut: "ControlOrMeta+Shift+Comma",
  },
  {
    id: "command-palette",
    selector: "openclaw-command-palette .cmd-palette__input",
    shortcut: "ControlOrMeta+K",
  },
  {
    id: "debug-overlay",
    selector: "openclaw-debug-overlay .debug-overlay__body",
    shortcut: "ControlOrMeta+Shift+D",
  },
  {
    id: "keyboard-shortcuts",
    selector: "openclaw-keyboard-shortcuts-dialog .shortcut-row",
    shortcut: "ControlOrMeta+/",
  },
  {
    id: "model-picker",
    selector: ".chat-controls__model-menu [data-chat-model-search]",
    trigger: ".chat-pane-cache__pane--active .chat-controls__model-trigger",
  },
];
const selected = values.scenarios?.split(",");
const scenarios = values["boot-only"]
  ? []
  : allScenarios.filter(({ id }) => !selected || selected.includes(id));
if (
  !values["boot-only"] &&
  (!scenarios.length || selected?.some((id) => !scenarios.some((scenario) => scenario.id === id)))
) {
  throw new Error(`Unknown scenarios; choose from ${allScenarios.map(({ id }) => id).join(",")}`);
}
const output = createControlUiE2eArtifactDir("navigation", values.output);
const metricNames = [
  "wallMs",
  "threadCpuMs",
  "traceScriptWallMs",
  "traceTaskWallMs",
  "capturedBeforeCpuMs",
  "capturedAfterCpuMs",
  "scriptMs",
  "taskMs",
  "layoutMs",
  "styleMs",
  "assetRequests",
  "assetWireBytes",
  "cachedAssetRequests",
  "serviceWorkerAssetRequests",
  "revalidatedAssetRequests",
  "workerRequests",
  "workerObservedBytes",
  "workerUnmeasuredFailures",
] as const;
type MetricName = (typeof metricNames)[number];
type Asset = {
  requestId: string;
  url: string;
  type: string;
  requestedAt: number;
  responseAt?: number;
  finishedAt?: number;
  status?: number;
  networkStatus?: number;
  cacheControl?: string;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  servedFromCache?: boolean;
  encodedBytes?: number;
  error?: string;
};
type Result = {
  profile: string;
  scenario: string;
  mode: string;
  pair: number;
  bundle: number;
  status: "passed" | "failed";
  artifact: string;
  wallMs?: number;
  threadCpuMs?: number;
  traceScriptWallMs?: number;
  traceTaskWallMs?: number;
  capturedBeforeCpuMs?: number;
  capturedAfterCpuMs?: number;
  scriptMs?: number;
  taskMs?: number;
  layoutMs?: number;
  styleMs?: number;
  assetRequests?: number;
  assetWireBytes?: number;
  cachedAssetRequests?: number;
  serviceWorkerAssetRequests?: number;
  revalidatedAssetRequests?: number;
  workerRequests?: number;
  workerObservedBytes?: number;
  workerUnmeasuredFailures?: number;
  workerAssets?: NavigationWorkerRequest[];
  workerPendingAtStart?: NavigationWorkerRequest[];
  startedAt?: number;
  cdpStartedAt?: number;
  cdpReadyAt?: number;
  readyAt?: number;
  assets?: Asset[];
  pendingAtStart?: string[];
  rpc?: Record<string, number>;
  error?: string;
};
const results: Result[] = [];
const host: unknown[] = [];
const servers: Array<{
  directory: string;
  build: { buildId: string; version: string };
  indexSha256: string;
  fixture: ReturnType<typeof createFixture>;
  server: Awaited<ReturnType<typeof startBuiltControlUiE2eServer>>;
}> = [];
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  headless: true,
});

function createFixture(buildId: string, version: string) {
  const fixture = createInteractionFixture(buildId, version);
  const config = {
    ...fixture.methodResponses["config.get"].config,
    gateway: { controlUi: { experimental: { claws: true } } },
  };
  return {
    ...fixture,
    featureMethods: [...defaultControlUiFeatureMethods, "claws.catalog.search"],
    methodResponses: {
      ...fixture.methodResponses,
      "config.get": {
        ...fixture.methodResponses["config.get"],
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
      },
      "claws.catalog.search": { entries: [] },
      "sessions.usage": {
        updatedAt: 1_800_000_000_000,
        startDate: "2026-10-01",
        endDate: "2026-10-24",
        sessions: [],
        totals: createEmptyCostUsageTotals(),
        aggregates: {
          messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
          tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
          byModel: [],
          byProvider: [],
          byAgent: [],
          byChannel: [],
          costDaily: [],
          modelDaily: [],
          daily: [],
        },
      } satisfies SessionsUsageResult,
      "node.list": { nodes: [] },
      "backup.status": { targets: [], schedules: [], locations: [] },
    },
  };
}

async function metrics(cdp: CDPSession) {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}
async function rpcCounts(page: Page) {
  return page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const request of (
      window as MockGatewayWindow
    ).openclawControlUiE2eGateway?.findRequests() ?? []) {
      counts[request.method] = (counts[request.method] ?? 0) + 1;
    }
    return counts;
  });
}
async function prepareTarget(page: Page, scenario: Scenario): Promise<Locator | undefined> {
  if (scenario.trigger) {
    const target = page.locator(scenario.trigger).first();
    await target.waitFor({ state: "visible" });
    return target;
  }
  if (scenario.shortcut || !scenario.routeId) {
    return undefined;
  }
  if (scenario.routeId === "new-session") {
    return page.locator(".sidebar-rail .sidebar-new-session");
  }
  const target = page.locator(`.sidebar-pages [data-sidebar-entry="route:${scenario.routeId}"] a`);
  if (!(await target.isVisible())) {
    await page
      .locator("openclaw-app-sidebar")
      .getByRole("button", { name: "Pages", exact: true })
      .click();
  }
  await target.waitFor({ state: "visible" });
  return target;
}

try {
  const directories = [
    values["bundle-dir"],
    values.aa ? values["bundle-dir"] : values["compare-bundle-dir"],
  ].filter((directory): directory is string => Boolean(directory));
  for (const directory of directories) {
    const resolved = path.resolve(directory);
    const html = await readFile(path.join(resolved, "index.html"), "utf8");
    const raw = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!raw) {
      throw new Error(`Missing production build identity: ${resolved}`);
    }
    const build: { buildId: string; version: string } = JSON.parse(raw);
    const fixture = createFixture(build.buildId, build.version);
    const servingDirectory = path.join(output, "bundles", String(servers.length));
    await mkdir(servingDirectory, { recursive: true });
    // Match src/gateway/control-ui-index.ts before deep-link document parsing.
    // Relative preview URLs otherwise give prefetched modules a different identity.
    await writeFile(
      path.join(servingDirectory, "index.html"),
      selectControlUiRoutePreloads(html, "chat")
        .replaceAll('src="./assets/', 'src="/assets/')
        .replaceAll('href="./assets/', 'href="/assets/'),
    );
    for (const entry of await readdir(resolved, { withFileTypes: true })) {
      if (!entry.name.startsWith("index.html")) {
        await symlink(
          path.join(resolved, entry.name),
          path.join(servingDirectory, entry.name),
          entry.isDirectory() ? "dir" : "file",
        );
      }
    }
    servers.push({
      directory: resolved,
      build,
      fixture,
      indexSha256: createHash("sha256").update(html).digest("hex"),
      server: await startBuiltControlUiE2eServer(
        servingDirectory,
        createControlUiMockBootstrapConfig(fixture),
      ),
    });
  }
  await writeFile(
    path.join(output, "manifest.json"),
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
        pairs,
        aa: values.aa,
        bootOnly: values["boot-only"],
        profiles,
        idleMs,
        intent: values.intent,
        intentMs,
        collection: values.trace
          ? "CDP metrics + timeline trace + exact input-to-ready thread CPU (no sampling Profiler)"
          : "untraced CDP metrics",
        fixture: { sessions: 1000, messagesPerSession: 400, models: 1000, cronJobs: 500 },
        readiness:
          "Native input event to route commit and visible destination on two animation frames; boot ends at an in-page two-frame visible transcript/composer marker and starts at navigation time origin. CPU includes the readiness probe and automation-to-assertion interval.",
        acceptance:
          "At least 10 interleaved base/head pairs. Median regression <=5% and p95 no worse (sub-1% p95 movement is noise); repeat noisy cells and use A/A plus CPU. Remote chunk-cached navigation target <=100ms.",
        limitations: [
          "Synthetic in-page Gateway RPC has no network latency; page and service-worker CDP 100ms / 10Mbps affect actual HTTP assets only.",
          "The built-server fixture mirrors Gateway immutable asset caching; it does not model authenticated Gateway RPC latency.",
          "Page response fromServiceWorker flags include cache hits and upstream fetches; page encoded bytes omit worker upstream bytes. Neither proves a cache hit.",
          "Worker upstream Network events and requests are recorded separately per context. Observed worker bytes use completed encoded totals (including headers), or incremental encoded body bytes for incomplete/aborted requests; action deltas include work already pending at action start. Failed requests without completion totals are counted separately: CDP can buffer partial bytes until completion, so observed bytes are a lower bound, never evidence that an aborted request used no network.",
          "Worker network events do not measure worker script CPU. A cache hit is only established by a separate CacheStorage probe, not by a page response flag or zero page bytes.",
          "A proof-only document copy applies the Gateway's canonical root asset href rewrite; asset bytes are symlinked unchanged from the recorded bundle.",
          "No page.route interception; Chromium HTTP cache and service worker remain enabled.",
          "One context per bundle/pair: destinations share dependencies during each sweep. Order rotates and reverses across pairs, identically for both bundles.",
          "Same-document revisit measures reused modules; chunk-cached sweep reloads chat first, keeping HTTP cache but discarding its module map.",
          "Keyboard dialogs have no hover intent trigger. Debug page is not a top-level Pages entry; the heavy Debug overlay uses its native shortcut.",
        ],
        scenarios,
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
  for (const profile of profiles) {
    for (let pair = 0; pair < pairs; pair++) {
      const observation = {
        profile: profile.id,
        pair,
        startedAt: new Date().toISOString(),
        startLoad: os.loadavg(),
        endedAt: "",
        endLoad: [] as number[],
      };
      // Alternate which bundle goes first to avoid giving one revision all cold-host slots.
      const order = servers.map((_, index) => index);
      if (pair % 2) {
        order.reverse();
      }
      const offset = scenarios.length ? pair % scenarios.length : 0;
      const destinations = [...scenarios.slice(offset), ...scenarios.slice(0, offset)];
      if (pair % 2) {
        destinations.reverse();
      }
      for (const bundle of order) {
        const slot = servers[bundle]!;
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "allow",
        });
        const workerNetwork = await emulateNavigationWorkerNetwork(browser, profile);
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
        await page.addInitScript("globalThis.__name = (fn) => fn");
        await page.addInitScript({ content: createControlUiMockGatewayInitScript(slot.fixture) });
        await page.addInitScript(() => {
          const state = { startedAt: 0, readyAt: 0 };
          Reflect.set(window, "__navigationBootBench", state);
          const visible = (element: Element | null) =>
            element !== null &&
            element.getClientRects().length > 0 &&
            !["hidden", "collapse"].includes(getComputedStyle(element).visibility);
          let readyFrame = false;
          const observe = () => {
            const snapshot = window.openclawControlUi?.snapshot();
            const route = snapshot?.route;
            const bubbles = document.querySelectorAll(
              ".chat-pane-cache__pane--active .chat-bubble",
            );
            const ready =
              snapshot?.routeReady &&
              route?.status === "success" &&
              route.matches[0]?.routeId === "chat" &&
              route.pendingMatches.length === 0 &&
              visible(bubbles.item(bubbles.length - 1)) &&
              [...document.querySelectorAll(".agent-chat__composer-combobox textarea")].some(
                visible,
              );
            if (ready && readyFrame) {
              state.readyAt = performance.now();
              performance.mark("navigation:boot-ready");
              return;
            }
            readyFrame = Boolean(ready);
            requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        });
        const cdp = await context.newCDPSession(page);
        const assets = new Map<string, Asset>();
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: profile.latency,
          downloadThroughput: profile.downloadThroughput,
          uploadThroughput: profile.uploadThroughput,
        });
        await cdp.send("Performance.enable");
        cdp.on("Network.requestWillBeSent", (event) =>
          assets.set(event.requestId, {
            requestId: event.requestId,
            url: event.request.url,
            type: event.type ?? "Other",
            requestedAt: event.timestamp,
          }),
        );
        cdp.on("Network.requestServedFromCache", (event) => {
          const asset = assets.get(event.requestId);
          if (asset) {
            asset.servedFromCache = true;
          }
        });
        cdp.on("Network.responseReceived", (event) => {
          const asset = assets.get(event.requestId);
          if (asset) {
            Object.assign(asset, {
              responseAt: event.timestamp,
              status: event.response.status,
              cacheControl: Object.entries(event.response.headers).find(
                ([name]) => name.toLowerCase() === "cache-control",
              )?.[1],
              fromDiskCache: event.response.fromDiskCache,
              fromServiceWorker: event.response.fromServiceWorker,
            });
          }
        });
        cdp.on("Network.loadingFinished", (event) => {
          const asset = assets.get(event.requestId);
          if (asset) {
            Object.assign(asset, {
              finishedAt: event.timestamp,
              encodedBytes: event.encodedDataLength,
            });
          }
        });
        cdp.on("Network.loadingFailed", (event) => {
          const asset = assets.get(event.requestId);
          if (asset) {
            Object.assign(asset, { finishedAt: event.timestamp, error: event.errorText });
          }
        });
        cdp.on("Network.responseReceivedExtraInfo", (event) => {
          const asset = assets.get(event.requestId);
          if (asset) {
            asset.networkStatus = event.statusCode;
          }
        });

        const measure = async (
          scenario: Scenario,
          mode: string,
          action: () => Promise<unknown>,
          boot = false,
        ) => {
          errors.length = 0;
          const artifact = `${profile.id}-${scenario.id}-${pair + 1}-${bundle}-${mode}`;
          const row: Result = {
            profile: profile.id,
            scenario: scenario.id,
            mode,
            pair,
            bundle,
            status: "failed",
            artifact,
          };
          const initialIds = new Set(assets.keys());
          const workerBefore = workerNetwork.snapshot();
          const initialWorkerIds = new Set(workerBefore.requests.map((request) => request.id));
          row.workerPendingAtStart = workerBefore.requests.filter(
            (request) => request.finishedAt === undefined,
          );
          row.pendingAtStart = [...assets.values()]
            .filter((asset) => !asset.finishedAt)
            .map((asset) => asset.url);
          const beforeRpc = boot ? {} : await rpcCounts(page);
          const traceEvents: unknown[] = [];
          const collectTrace = ({ value }: { value: unknown[] }) => traceEvents.push(...value);
          let tracing = false;
          try {
            workerNetwork.assertHealthy();
            if (values.trace) {
              cdp.on("Tracing.dataCollected", collectTrace);
              await cdp.send("Tracing.start", {
                categories: "toplevel,blink.user_timing,devtools.timeline",
                transferMode: "ReportEvents",
              });
              tracing = true;
            }
            if (!boot) {
              await page.evaluate(
                ({ selector, routeId, eventType }) => {
                  const state = { startedAt: 0, readyAt: 0 };
                  Reflect.set(window, "__navigationBench", state);
                  const start = () => {
                    state.startedAt = performance.now();
                    performance.mark("navigation:start");
                    const ready = () => {
                      const element = document.querySelector(selector);
                      const snapshot = window.openclawControlUi?.snapshot();
                      const route = snapshot?.route;
                      if (
                        (!routeId ||
                          (snapshot?.routeReady &&
                            route?.status === "success" &&
                            route.matches[0]?.routeId === routeId &&
                            route.pendingMatches.length === 0)) &&
                        element?.getClientRects().length
                      ) {
                        requestAnimationFrame(() => {
                          state.readyAt = performance.now();
                          performance.mark("navigation:end");
                        });
                      } else {
                        requestAnimationFrame(ready);
                      }
                    };
                    requestAnimationFrame(ready);
                  };
                  document.addEventListener(eventType, start, {
                    capture: true,
                    once: true,
                  });
                },
                {
                  selector: scenario.selector,
                  routeId: scenario.routeId,
                  eventType: scenario.shortcut ? "keydown" : "click",
                },
              );
            }
            const before = await metrics(cdp);
            row.cdpStartedAt = before.Timestamp;
            await action();
            if (boot) {
              await page.waitForFunction(
                () => Reflect.get(window, "__navigationBootBench")?.readyAt > 0,
              );
              const timing: { startedAt: number; readyAt: number } = await page.evaluate(() =>
                Reflect.get(window, "__navigationBootBench"),
              );
              Object.assign(row, timing);
            } else {
              await page.waitForFunction(
                () => Reflect.get(window, "__navigationBench")?.readyAt > 0,
              );
              const timing: { startedAt: number; readyAt: number } = await page.evaluate(() =>
                Reflect.get(window, "__navigationBench"),
              );
              Object.assign(row, timing);
            }
            workerNetwork.assertHealthy();
            row.wallMs = row.readyAt! - row.startedAt!;
            const after = await metrics(cdp);
            row.cdpReadyAt = after.Timestamp;
            for (const [key, metric] of [
              ["scriptMs", "ScriptDuration"],
              ["taskMs", "TaskDuration"],
              ["layoutMs", "LayoutDuration"],
              ["styleMs", "RecalcStyleDuration"],
            ] as const) {
              // Duration counters reset at document navigation, unlike Timestamp.
              row[key] = (after[metric]! - (boot ? 0 : before[metric]!)) * 1000;
              if (!Number.isFinite(row[key]) || row[key] < 0) {
                throw new Error(
                  `Invalid ${metric} interval: ${before[metric]} -> ${after[metric]}`,
                );
              }
            }
            const afterRpc = await rpcCounts(page);
            row.rpc = Object.fromEntries(
              Object.entries(afterRpc)
                .map(([method, count]) => [method, count - (beforeRpc[method] ?? 0)])
                .filter(([, count]) => count !== 0),
            );
            if (errors.length) {
              throw new Error(errors.join("\n"));
            }
            row.status = "passed";
          } catch (error) {
            row.error = String(error);
          } finally {
            if (tracing) {
              const done = new Promise<void>((resolve) => {
                cdp.once("Tracing.tracingComplete", () => resolve());
              });
              await cdp.send("Tracing.end");
              await done;
            }
            cdp.removeListener("Tracing.dataCollected", collectTrace);
            if (values.trace) {
              await writeFile(
                path.join(output, `${artifact}.trace.json`),
                JSON.stringify({ traceEvents }),
              );
            }
            if (values.trace && !boot && row.status === "passed") {
              const trace = summarizeInteractionTrace(traceEvents, {
                start: "navigation:start",
                end: "navigation:end",
              });
              const cpu = summarizeMarkedThreadCpu(traceEvents);
              Object.assign(row, {
                threadCpuMs: cpu.threadCpuMs,
                traceScriptWallMs: trace.scriptMs,
                traceTaskWallMs: trace.busyMs,
                capturedBeforeCpuMs: cpu.capturedBeforeCpuMs,
                capturedAfterCpuMs: cpu.capturedAfterCpuMs,
              });
              await writeFile(
                path.join(output, `${artifact}.marked-cpu.json`),
                JSON.stringify({ trace, cpu }, null, 2),
              );
            }
            row.assets = [...assets.values()].filter((asset) => !initialIds.has(asset.requestId));
            row.assetRequests = row.assets.length;
            row.assetWireBytes = row.assets.reduce(
              (total, asset) => total + (asset.encodedBytes ?? 0),
              0,
            );
            row.cachedAssetRequests = row.assets.filter(
              (asset) => asset.servedFromCache || asset.fromDiskCache,
            ).length;
            row.serviceWorkerAssetRequests = row.assets.filter(
              (asset) => asset.fromServiceWorker,
            ).length;
            row.revalidatedAssetRequests = row.assets.filter(
              (asset) => asset.networkStatus === 304,
            ).length;
            const workerAfter = workerNetwork.snapshot();
            row.workerAssets = workerAfter.requests.filter(
              (request) => !initialWorkerIds.has(request.id),
            );
            row.workerRequests = row.workerAssets.length;
            row.workerObservedBytes = workerAfter.observedBytes - workerBefore.observedBytes;
            const priorFailures = new Set(
              workerBefore.requests.filter((request) => request.error).map((request) => request.id),
            );
            row.workerUnmeasuredFailures = workerAfter.requests.filter(
              (request) =>
                request.error &&
                request.encodedBytes === undefined &&
                !priorFailures.has(request.id),
            ).length;
            if (values.screenshots || row.status === "failed") {
              await page.screenshot({ path: path.join(output, `${artifact}.png`) }).catch(() => {});
            }
            results.push(row);
            await writeFile(
              path.join(output, `${artifact}.json`),
              JSON.stringify({ ...row, errors }, null, 2),
            );
            await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
            console.log(
              JSON.stringify({
                ...row,
                assets: row.assets.length,
                workerAssets: row.workerRequests,
              }),
            );
          }
          if (row.status === "failed") {
            throw new Error(`${artifact}: ${row.error}`);
          }
        };
        const chatUrl = new URL(controlUiSessionPath(slot.fixture.sessionKey), slot.server.baseUrl)
          .href;
        const idle = async (mode: string) => {
          await page.waitForTimeout(idleMs);
          const snapshot = await page.evaluate(() => ({
            atMs: performance.now(),
            bootReadyAt: Reflect.get(window, "__navigationBootBench")?.readyAt ?? null,
            prefetchResources: performance
              .getEntriesByType("resource")
              .filter((entry) =>
                /navigation-preloads-|new-session-page-entry-|app-shell-idle\.runtime-/u.test(
                  entry.name,
                ),
              )
              .map((entry) => ({
                name: entry.name,
                startTime: entry.startTime,
                duration: entry.duration,
              })),
            styleSheets: [...document.styleSheets].map((sheet) => sheet.href),
            links: [...document.querySelectorAll<HTMLLinkElement>("link[href]")].map((link) => ({
              href: link.href,
              rel: link.rel,
              as: link.as,
              activeSheet: link.sheet !== null,
            })),
          }));
          await writeFile(
            path.join(output, `${profile.id}-${pair + 1}-${bundle}-${mode}-idle.json`),
            JSON.stringify(snapshot, null, 2),
          );
        };
        try {
          const chat = { id: "chat", selector: ".chat-bubble" };
          await measure(chat, "boot", () => page.goto(chatUrl, { waitUntil: "commit" }), true);
          await idle("boot");
          for (const mode of ["first", "same-document", "chunk-cached"] as const) {
            if (mode === "chunk-cached") {
              await measure(
                chat,
                "reload-transcript",
                () => page.goto(chatUrl, { waitUntil: "commit" }),
                true,
              );
              await idle("reload-transcript");
            }
            for (const scenario of destinations) {
              const target = await prepareTarget(page, scenario);
              if (target && values.intent !== "none") {
                if (values.intent === "hover") {
                  await target.hover();
                } else {
                  await target.focus();
                }
                await page.waitForTimeout(intentMs);
              }
              try {
                await measure(scenario, mode, () =>
                  target ? target.click() : page.keyboard.press(scenario.shortcut!),
                );
              } catch (error) {
                console.error(String(error));
              }
              if (scenario.routeId) {
                await page.goBack();
                await waitForControlUiRoute(page, { routeId: "chat" });
              } else {
                await page.keyboard.press(
                  scenario.id === "debug-overlay" ? scenario.shortcut! : "Escape",
                );
                await page.locator(scenario.selector).first().waitFor({ state: "hidden" });
              }
            }
          }
        } catch (error) {
          console.error(String(error));
        } finally {
          await writeFile(
            path.join(output, `${profile.id}-${pair + 1}-${bundle}-network.json`),
            JSON.stringify([...assets.values()], null, 2),
          );
          await writeFile(
            path.join(output, `${profile.id}-${pair + 1}-${bundle}-worker-network.json`),
            JSON.stringify(
              { ...workerNetwork.snapshot(), events: workerNetwork.events() },
              null,
              2,
            ),
          );
          await cdp.detach().catch(() => {});
          await context.close();
          await workerNetwork.close();
        }
      }
      observation.endedAt = new Date().toISOString();
      observation.endLoad = os.loadavg();
      host.push(observation);
      await writeFile(path.join(output, "host-load.json"), JSON.stringify(host, null, 2));
    }
  }
} finally {
  await browser.close();
  for (const slot of servers) {
    await slot.server.close();
  }
}

function distribution(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
}
const cells = [
  ...new Set(results.map((row) => `${row.profile}/${row.scenario}/${row.mode}/${row.bundle}`)),
].map((key) => {
  const [profile, scenario, mode, bundle] = key.split("/");
  const rows = results.filter(
    (row) =>
      row.profile === profile &&
      row.scenario === scenario &&
      row.mode === mode &&
      row.bundle === Number(bundle),
  );
  const good = rows.filter((row) => row.status === "passed");
  return {
    profile,
    scenario,
    mode,
    bundle: Number(bundle),
    passed: good.length,
    failed: rows.length - good.length,
    metrics: Object.fromEntries(
      metricNames.map((metric) => [
        metric,
        good.length ? distribution(good.map((row) => row[metric]!)) : null,
      ]),
    ),
    targetMet:
      mode === "chunk-cached" && good.length
        ? distribution(good.map((row) => row.wallMs!)).p95 <= 100
        : undefined,
  };
});
const comparisons = cells
  .filter((cell) => cell.bundle === 0)
  .flatMap((base) => {
    const head = cells.find(
      (cell) =>
        cell.bundle === 1 &&
        cell.profile === base.profile &&
        cell.scenario === base.scenario &&
        cell.mode === base.mode,
    );
    return head
      ? metricNames.flatMap((metric: MetricName) => {
          const before = base.metrics[metric];
          const after = head.metrics[metric];
          return before && after
            ? [
                {
                  profile: base.profile,
                  scenario: base.scenario,
                  mode: base.mode,
                  metric,
                  before,
                  after,
                  medianPercent: before.median ? (after.median / before.median - 1) * 100 : null,
                  p95Percent: before.p95 ? (after.p95 / before.p95 - 1) * 100 : null,
                },
              ]
            : [];
        })
      : [];
  });
const planned = profiles.length * pairs * servers.length * (2 + scenarios.length * 3);
await writeFile(
  path.join(output, "summary.json"),
  JSON.stringify(
    {
      planned,
      executed: results.length,
      failed: results.filter((row) => row.status === "failed").length,
      skipped: planned - results.length,
      cells,
      comparisons,
    },
    null,
    2,
  ),
);
console.log(`Navigation artifacts: ${output}`);
if (results.length !== planned || results.some((row) => row.status === "failed")) {
  process.exitCode = 1;
}
