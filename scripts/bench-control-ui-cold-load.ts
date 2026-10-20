// Opt-in production-bundle benchmark; real delays model wire delivery, not test synchronization.
// --cpu-profile: source-mapped reload/live/streaming tables and per-run/median cpu-profile.json.
// --cpu-profile-compare <baseline cpu-profile.json>: profile and diff against that report.
// Sampling inflates timings: never compare profiled runs with unprofiled runs.
// --session-event-duration-ms 135000 --session-event-ancestor-refs extends the native churn.
// Pair built bundles with --fixture-now-ms and --live-start-at-ms (one run per process).
// OPENCLAW_CONTROL_UI_BUILD_ID supplies the matching identity outside a Git checkout.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.js";
import { captureSessionRowGeneration } from "../src/gateway/session-row-identity.js";
import { shareSidebarSessionRows } from "../src/gateway/session-row-presentation.js";
import { createColdLoadProbeInitScript } from "../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  controlUiSessionPath,
  controlUiSessionUrl,
  controlUiBundledSettingsStorageKey,
  prepareControlUiMockGatewayScenario,
  resolvePlaywrightChromiumExecutablePath,
  startProductionControlUiE2eServer,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSandboxFixtureServer } from "../ui/src/test-helpers/control-ui-sandbox-fixture-server.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  createControlUiStreamingReply,
  createStreamingReplyProbeInitScript,
} from "../ui/src/test-helpers/control-ui-streaming-reply.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import {
  persistColdLoadWarmState,
  restoreColdLoadWarmState,
} from "./lib/control-ui-bench-warm-state.ts";
import {
  compareCpuTables,
  formatCpuTables,
  medianCpuTables,
  readCpuProfileReport,
  type ColdLoadCpuTables,
  mapColdLoadCpuProfile,
  prepareColdLoadTraceEvent,
  summarizeColdLoadTrace,
  summarizeCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import { installWidgetReadiness } from "./lib/control-ui-dashboard-probe.ts";
import { probeColdLoadOverlays } from "./lib/control-ui-overlay-probe.ts";
import { warmReloadProbe } from "./lib/control-ui-warm-reload-probe.ts";

function readRigProbeSnapshot() {
  const perf = Reflect.get(window, "__perf");
  return {
    atMs: performance.now(),
    attribution: [...(Reflect.get(window, "__mutAttr") ?? new Map())],
    mutations: structuredClone([...(perf?.mut ?? new Map())]),
    loaf: [...(perf?.loaf ?? [])],
    paints: [...(perf?.paints ?? [])],
    rpc: [...(Reflect.get(window, "__wsLog") ?? [])],
    avatarRequests: performance
      .getEntriesByType("resource")
      .filter((entry) => /\/api\/users\/[^/]+\/avatar/u.test(new URL(entry.name).pathname))
      .map((entry) => ({ url: entry.name, start: entry.startTime, duration: entry.duration })),
  };
}

function summarizeResponseTasks(raw: unknown[]) {
  const events = raw.map(prepareColdLoadTraceEvent);
  const tasks: Array<{ pid: number; tid: number; start: number; end: number }> = [];
  const stacks = new Map<string, (typeof events)[number][]>();
  const add = (event: (typeof events)[number], end: number) => {
    if (event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask") {
      tasks.push({ pid: event.pid, tid: event.tid, start: event.ts, end });
    }
  };
  for (const event of events) {
    if (event.ph === "X" && event.dur !== undefined) {
      add(event, event.ts + event.dur);
    } else if (event.ph === "B") {
      const key = `${event.pid}:${event.tid}`;
      const stack = stacks.get(key) ?? [];
      stack.push(event);
      stacks.set(key, stack);
    } else if (event.ph === "E") {
      const begin = stacks.get(`${event.pid}:${event.tid}`)?.pop();
      if (begin) {
        add(begin, event.ts);
      }
    }
  }
  const responses = events.flatMap((event) => {
    const match = /^cold-load-rpc:(\d+):(.+):start$/u.exec(event.name ?? "");
    if (!match) {
      return [];
    }
    const task = tasks
      .filter(
        (candidate) =>
          candidate.pid === event.pid &&
          candidate.tid === event.tid &&
          candidate.start <= event.ts &&
          candidate.end >= event.ts,
      )
      .toSorted((left, right) => left.end - left.start - (right.end - right.start))[0];
    if (!task) {
      throw new Error(`Response mark lacks an enclosing renderer task: ${event.name}`);
    }
    return [
      { rpcIndex: Number(match[1]), method: match[2], taskMs: (task.end - task.start) / 1000 },
    ];
  });
  return {
    measurement:
      "response task including application JSON parse and reconciliation microtasks; excludes later animation-frame rendering",
    responses,
  };
}

type LiveRpc = {
  method: string;
  params: Record<string, unknown>;
  ms: number;
  responseAtMs: number;
  responseBytes: number;
};

function requestedAtMs(rpc: LiveRpc) {
  return rpc.responseAtMs - rpc.ms;
}

function sidebarWindow(params: Record<string, unknown>) {
  if (params.rowMode !== "sidebar" || params.limit !== 200) {
    return null;
  }
  return params.ownerFirst === true
    ? "ownerFirst"
    : params.involvingMe === true
      ? "involvingMe"
      : null;
}

function summarizeSidebarWindows(
  rpcs: LiveRpc[],
  rpcOffset: number,
  reads: ReturnType<ReturnType<typeof createTeamScaleSidebarListOwner>["stats"]>,
  tasks: ReturnType<typeof summarizeResponseTasks>,
  activeStreamMs: number,
  elapsedMs: number,
) {
  return Object.fromEntries(
    (["ownerFirst", "involvingMe"] as const).map((window) => {
      const windowReads = reads.filter((read) => sidebarWindow(read.params) === window);
      const windowRpcs = rpcs
        .map((rpc, index) => ({ ...rpc, rpcIndex: rpcOffset + index }))
        .filter((rpc) => rpc.method === "sessions.list" && sidebarWindow(rpc.params) === window);
      if (windowReads.length !== windowRpcs.length) {
        throw new Error(`Sidebar ${window} response/stat count mismatch`);
      }
      const samples = windowRpcs.map((rpc, index) => {
        const task = tasks.responses.find((response) => response.rpcIndex === rpc.rpcIndex);
        if (!task) {
          throw new Error(`Sidebar response ${rpc.rpcIndex} lacks a task measurement`);
        }
        return Object.assign({}, windowReads[index]!, {
          requestedAtMs: requestedAtMs(rpc),
          responseAtMs: rpc.responseAtMs,
          wireBytes: rpc.responseBytes,
          responseTaskMs: task.taskMs,
        });
      });
      const taskMs = samples.map((sample) => sample.responseTaskMs).toSorted((a, b) => a - b);
      const median = taskMs.length
        ? (taskMs[Math.floor((taskMs.length - 1) / 2)]! + taskMs[Math.floor(taskMs.length / 2)]!) /
          2
        : 0;
      return [
        window,
        {
          reads: samples.length,
          readsPerMinuteObserved: (samples.length * 60_000) / elapsedMs,
          readsPerMinuteNormalizedToActiveStream: (samples.length * 60_000) / activeStreamMs,
          changedRows: samples.reduce((sum, sample) => sum + sample.changedRows, 0),
          rowsSent: samples.reduce((sum, sample) => sum + sample.rowsSent, 0),
          wireBytes: samples.reduce((sum, sample) => sum + sample.wireBytes, 0),
          responseTaskMs: { sum: taskMs.reduce((sum, value) => sum + value, 0), median },
          samples,
        },
      ];
    }),
  );
}

const { values } = parseArgs({
  options: {
    "cpu-profile": { type: "boolean", default: false },
    "cpu-profile-compare": { type: "string" },
    "warm-reload": { type: "boolean", default: false },
    "large-snapshot": { type: "boolean", default: false },
    "dashboard-widget": { type: "boolean", default: false },
    "connect-not-before-ms": { type: "string", default: "0" },
    "transcript-messages": { type: "string" },
    "overlay-probe": { type: "boolean", default: false },
    untraced: { type: "boolean", default: false },
    "probe-dir": { type: "string" },
    "live-events": { type: "boolean", default: false },
    "streaming-reply": { type: "boolean", default: false },
    "session-switch": { type: "boolean", default: false },
    "init-script": { type: "string", multiple: true, default: [] },
    "sidebar-list-churn": { type: "boolean", default: false },
    "sidebar-live-churn": { type: "boolean", default: false },
    "session-event-churn": { type: "boolean", default: false },
    "session-event-duration-ms": { type: "string", default: "30000" },
    "session-event-ancestor-refs": { type: "boolean", default: false },
    "fixture-now-ms": { type: "string" },
    "live-start-at-ms": { type: "string" },
    "duplicate-boot-reads": { type: "boolean", default: false },
    "dashboard-mcp-app": { type: "boolean", default: false },
    "chat-dashboard-route": { type: "boolean", default: false },
    "closed-menu-members": { type: "boolean", default: false },
    "capture-ms": { type: "string", default: "0" },
    "sidebar-row-transfer": { type: "string", default: "full" },
    "bundle-dir": { type: "string" },
    port: { type: "string" },
    "sandbox-port": { type: "string" },
    "compare-bundle-dir": { type: "string", multiple: true, default: [] },
    runs: { type: "string", default: "3" },
    "latency-ms": { type: "string", default: "35" },
    "method-latency-ms": { type: "string", multiple: true, default: [] },
    face: { type: "string", default: "dashboard" },
    "short-route": { type: "boolean", default: false },
    "full-uuid-route": { type: "boolean", default: false },
    "frame-gap-ms": { type: "string", default: "4" },
    "sidebar-view": { type: "string", default: "sessions" },
    output: { type: "string", default: ".artifacts/control-ui-cold-load" },
  },
});
if (values["streaming-reply"] && values["live-events"]) {
  throw new Error("streaming-reply measures an isolated answer; do not combine with live-events");
}
if (values["warm-reload"] && !values["probe-dir"]) {
  throw new Error("warm-reload requires probe-dir with LoAF/mutation and RPC census init scripts");
}
if (values["sidebar-list-churn"] && !values["live-events"]) {
  throw new Error("sidebar-list-churn requires live-events");
}
if (values["sidebar-list-churn"] && values.untraced) {
  throw new Error("sidebar-list-churn requires tracing for response task attribution");
}
if (values["sidebar-live-churn"] && (!values["live-events"] || values["sidebar-list-churn"])) {
  throw new Error("sidebar-live-churn requires live-events and excludes sidebar-list-churn");
}
if (values["session-event-ancestor-refs"] && !values["session-event-churn"]) {
  throw new Error("session-event-ancestor-refs requires session-event-churn");
}
const sidebarRowTransfer = values["sidebar-row-transfer"];
if (!["full", "delta", "interleaved"].includes(sidebarRowTransfer)) {
  throw new Error("Expected sidebar-row-transfer full, delta or interleaved");
}
if (!values["sidebar-list-churn"] && sidebarRowTransfer !== "full") {
  throw new Error("sidebar-row-transfer requires sidebar-list-churn");
}
const sidebarView = values["sidebar-view"];
if (sidebarView !== "sessions" && sidebarView !== "online") {
  throw new Error("Expected sidebar-view sessions or online");
}
const cpuProfile = values["cpu-profile"] || Boolean(values["cpu-profile-compare"]);
const baselineCpu = values["cpu-profile-compare"]
  ? readCpuProfileReport(JSON.parse(await readFile(values["cpu-profile-compare"], "utf8")), [
      "reload",
      ...(values["live-events"] ? ["live"] : []),
      ...(values["streaming-reply"] ? ["streaming"] : []),
      ...(values["session-switch"] ? ["session-switch"] : []),
    ])
  : undefined;
const cpuRuns: Record<string, ColdLoadCpuTables[]> = {};
const runs = Number(values.runs);
const latencyMs = Number(values["latency-ms"]);
const connectNotBeforeMs = Number(values["connect-not-before-ms"]);
const methodLatencyMs: Record<string, number> = {};
for (const value of values["method-latency-ms"]) {
  const [method, delay, ...extra] = value.split("=");
  const milliseconds = Number(delay);
  if (
    !method ||
    delay === undefined ||
    extra.length ||
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    throw new Error("Expected method-latency-ms method=nonnegative-milliseconds");
  }
  methodLatencyMs[method] = milliseconds;
}
const face = values.face;
if (face !== "chat" && face !== "dashboard") {
  throw new Error("Expected face chat or dashboard");
}
if (values["chat-dashboard-route"] && face !== "dashboard") {
  throw new Error("chat-dashboard-route requires the dashboard face");
}
const frameGapMs = Number(values["frame-gap-ms"]);
const captureMs = Number(values["capture-ms"]);
const transcriptMessages =
  values["transcript-messages"] === undefined ? undefined : Number(values["transcript-messages"]);
const sessionEventDurationMs = Number(values["session-event-duration-ms"]);
const fixtureNowMs =
  values["fixture-now-ms"] === undefined ? undefined : Number(values["fixture-now-ms"]);
const liveStartAtMs =
  values["live-start-at-ms"] === undefined ? undefined : Number(values["live-start-at-ms"]);
const port = values.port === undefined ? undefined : Number(values.port);
const sandboxPort =
  values["sandbox-port"] === undefined ? undefined : Number(values["sandbox-port"]);
if (
  (port !== undefined || sandboxPort !== undefined) &&
  (!values["bundle-dir"] ||
    port === sandboxPort ||
    [port, sandboxPort].some(
      (value) =>
        value === undefined || !Number.isInteger(value) || value < 40_000 || value > 65_535,
    ))
) {
  throw new Error(
    "Explicit port and sandbox-port require a built bundle and distinct ports from 40000 to 65535",
  );
}
if (
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > (values["compare-bundle-dir"].length ? 60 : 20) ||
  !Number.isFinite(latencyMs) ||
  latencyMs < 0 ||
  !Number.isFinite(connectNotBeforeMs) ||
  connectNotBeforeMs < 0 ||
  !Number.isFinite(frameGapMs) ||
  frameGapMs < 0 ||
  !Number.isFinite(captureMs) ||
  captureMs < 0 ||
  (transcriptMessages !== undefined &&
    (!Number.isSafeInteger(transcriptMessages) || transcriptMessages < 1)) ||
  !Number.isSafeInteger(sessionEventDurationMs) ||
  sessionEventDurationMs < 250 ||
  sessionEventDurationMs % 125 !== 0 ||
  [fixtureNowMs, liveStartAtMs].some(
    (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0),
  )
) {
  throw new Error(
    "Expected a bounded run count, positive transcript size, nonnegative wire delays/timestamps, and session duration in 125ms steps (at least 250ms)",
  );
}
if (
  values["compare-bundle-dir"].length &&
  (!values["bundle-dir"] ||
    (!values["warm-reload"] && !values["streaming-reply"]) ||
    !values.untraced ||
    cpuProfile ||
    values["compare-bundle-dir"].length > 2 ||
    runs % (values["compare-bundle-dir"].length + 1))
) {
  throw new Error(
    "Bundle comparison requires complete cycles of two or three unprofiled warm or streaming bundles",
  );
}
if (sidebarRowTransfer === "interleaved" && (runs < 14 || runs % 2 !== 0)) {
  throw new Error("Interleaved sidebar transfer requires an even run count of at least 14");
}
if (liveStartAtMs !== undefined && (runs !== 1 || !values["live-events"])) {
  throw new Error("live-start-at-ms requires one live-events run");
}
const artifactDir = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
await mkdir(artifactDir, { recursive: true });
const explicitBuildId = process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim();
const head = explicitBuildId
  ? null
  : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const buildId = explicitBuildId ?? head!;
const dirty = explicitBuildId
  ? null
  : execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const bundleDir = values["bundle-dir"]
  ? path.resolve(values["bundle-dir"])
  : path.join(artifactDir, "ui");
const server = values["bundle-dir"]
  ? await startBuiltControlUiE2eServer(bundleDir, undefined, port)
  : await startProductionControlUiE2eServer(bundleDir, buildId);
const comparisonBundleDirs = values["compare-bundle-dir"].map((directory) =>
  path.resolve(directory),
);
const parkedBaselineDir = path.join(artifactDir, "baseline-bundle");
const bundleSlots = [parkedBaselineDir, ...comparisonBundleDirs];
let activeBundle = 0;
async function selectComparisonBundle(index: number) {
  if (!comparisonBundleDirs.length || activeBundle === index) {
    return;
  }
  await server.replaceBuild(bundleSlots[index]!, bundleSlots[activeBundle]!);
  activeBundle = index;
}
const dashboardFont = values["dashboard-widget"]
  ? await readFile("ui/public/fonts/space-grotesk-latin.woff2")
  : undefined;
const dashboardFontPath = "/__openclaw__/bench/dashboard-font.woff2";
const sandbox = createControlUiSandboxFixtureServer((pathname) =>
  dashboardFont && pathname === dashboardFontPath
    ? { contentType: "font/woff2", body: dashboardFont }
    : fixture.assets.get(pathname),
);
await new Promise<void>((resolve, reject) => {
  sandbox.once("error", reject);
  sandbox.listen(sandboxPort ?? 0, "127.0.0.1", resolve);
});
const address = sandbox.address();
if (!address || typeof address === "string") {
  throw new Error("Sandbox did not bind");
}
const fixture = createControlUiTeamScaleFixture({
  now: fixtureNowMs,
  baseUrl: server.baseUrl,
  sandboxUrl: buildSandboxHostPath({
    blockDescendantFrames: true,
    resourceDomains: values["dashboard-mcp-app"]
      ? [`http://127.0.0.1:${address.port}`]
      : values["dashboard-widget"]
        ? [new URL(server.baseUrl).origin]
        : undefined,
  }),
  sandboxPort: address.port,
  liveRun: values["live-events"] || values["streaming-reply"],
  sidebarListChurn: values["sidebar-list-churn"],
  sidebarLiveChurn: values["sidebar-live-churn"],
  sessionEventChurn: values["session-event-churn"],
  sessionEventDurationMs,
  sessionEventAncestorRefs: values["session-event-ancestor-refs"],
  duplicateBootReads: values["duplicate-boot-reads"],
  dashboardMcpApp: values["dashboard-mcp-app"]
    ? { font: await readFile("ui/public/fonts/space-grotesk-latin.woff2") }
    : undefined,
  closedMenuMembers: values["closed-menu-members"],
  largeSnapshot: values["large-snapshot"],
  transcriptMessages,
  dashboardWidgetFontUrl: dashboardFont
    ? `http://127.0.0.1:${address.port}${dashboardFontPath}`
    : undefined,
});
const streamingReply = values["streaming-reply"] ? createControlUiStreamingReply() : undefined;
const extraInitScripts = await Promise.all(
  values["init-script"].map((file) => readFile(file, "utf8")),
);
let sidebarLists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
let runTransfer: "full" | "delta" = sidebarRowTransfer === "delta" ? "delta" : "full";
let browser: Browser | undefined;
const results = [];
try {
  const prepared = await prepareControlUiMockGatewayScenario({
    ...fixture.scenario,
    serverBuildId: buildId,
    serverVersion: JSON.parse(await readFile("package.json", "utf8")).version,
  });
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1719, height: 1179 },
    serviceWorkers: "block",
    permissions: ["local-network-access"],
  });
  const page = await context.newPage();
  await page.addInitScript("globalThis.__name = (fn) => fn");
  const rigProbeScript = values["probe-dir"]
    ? (
        await Promise.all(
          ["mutattr.init.js", "loaf-mutation.init.js", "ws-rpc-census.init.js"].map((filename) =>
            readFile(path.resolve(values["probe-dir"]!, filename), "utf8"),
          ),
        )
      ).join("\n") + `\nwindow.__readColdLoadRigProbes = ${readRigProbeSnapshot.toString()};`
    : "";
  await context.exposeBinding("__teamScaleList", (_source, params: Record<string, unknown>) => {
    const { result, previousRows } = sidebarLists.list(params);
    const response =
      params.rowMode === "sidebar" || params.ifRowsRevision !== undefined
        ? {
            ...result,
            ...shareSidebarSessionRows(
              result.sessions,
              typeof params.ifRowsRevision === "string" ? params.ifRowsRevision : undefined,
              runTransfer === "delta" && previousRows
                ? [captureSessionRowGeneration(previousRows)]
                : undefined,
            ),
          }
        : result;
    sidebarLists.recordWire(response);
    return response;
  });
  await context.exposeBinding(
    "__teamScaleMutate",
    (
      _source,
      mutation: Parameters<ReturnType<typeof createTeamScaleSidebarListOwner>["apply"]>[0],
    ) => sidebarLists.apply(mutation),
  );
  await context.exposeBinding("__teamScaleCronList", (_source, params: Record<string, unknown>) =>
    fixture.listCronJobs(params),
  );
  const errors: string[] = [];
  const harnessWarnings: string[] = [];
  page.on("pageerror", (error) => {
    // Playwright's serviceWorkers:block init script also runs in opaque sandbox frames.
    if (
      error.name === "SecurityError" &&
      error.message ===
        "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag." &&
      error.stack?.includes("at <anonymous>:3:15")
    ) {
      harnessWarnings.push(error.message);
    } else {
      errors.push(error.stack ?? error.message);
    }
  });
  await page.route("**/control-ui-config.json", (route) =>
    route.fulfill({ json: createControlUiMockBootstrapConfig(prepared.scenario) }),
  );
  const assets = new Map<string, { body: string | Buffer; contentType: string }>([
    ...fixture.assets,
    ...prepared.assets,
  ]);
  await page.route("**/__openclaw__/**", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset
      ? route.fulfill({
          status: 200,
          ...asset,
        })
      : route.fallback();
  });
  if (values["duplicate-boot-reads"]) {
    await page.route("**/api/chat/media/outgoing/**", (route) => {
      const asset = assets.get(new URL(route.request().url()).pathname);
      return asset ? route.fulfill({ status: 200, ...asset }) : route.fallback();
    });
  }
  if (values["sidebar-live-churn"] || values["closed-menu-members"]) {
    await page.route("**/api/users/*/avatar?*", async (route) => {
      const asset = fixture.assets.get(new URL(route.request().url()).pathname);
      if (!asset) {
        return route.fallback();
      }
      const { delayMs, ...response } = asset;
      if (delayMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      return route.fulfill(response);
    });
  }
  await page.addInitScript(
    ({ key, pins, mode }) => {
      if (window !== window.top) {
        return;
      }
      if (!localStorage.getItem(key)) {
        localStorage.setItem(
          key,
          JSON.stringify({
            sidebarAgentsMode: mode,
            railShortcuts: pins,
            navigationByProfile: { "team-person-001": { railShortcuts: pins } },
          }),
        );
      }
    },
    {
      key: controlUiBundledSettingsStorageKey(server.baseUrl),
      pins: fixture.sidebarEntries,
      mode:
        !values["session-event-ancestor-refs"] &&
        (values["sidebar-list-churn"] ||
          values["sidebar-live-churn"] ||
          values["session-event-churn"])
          ? "roster"
          : "chip",
    },
  );
  const warmProbes = values["warm-reload"] ? `\n(${warmReloadProbe.toString()})();` : "";
  await page.addInitScript({
    content: `;(() => { if (window !== window.top) return; const __name = (fn) => fn; (${installWidgetReadiness.toString()})(); ${createControlUiMockGatewayInitScript(prepared.scenario)}\n${rigProbeScript}\nwindow.__teamScaleSidebarLists = { apply: (mutation) => window.__teamScaleMutate(mutation) }; window.openclawControlUiE2eGateway.setRequestHandler("sessions.list", async ({ params, respond }) => respond(await window.__teamScaleList(params))); window.openclawControlUiE2eGateway.setRequestHandler("cron.list", async ({ params, respond }) => respond(await window.__teamScaleCronList(params)));\n${createColdLoadProbeInitScript({ latencyMs, methodLatencyMs, connectNotBeforeMs, frameGapMs, events: fixture.events, liveEvents: fixture.liveEvents, liveHistory: fixture.liveHistory, ownerProbes: !cpuProfile && !values["session-event-churn"] })}\n${streamingReply ? createStreamingReplyProbeInitScript() : ""}\n${extraInitScripts.join("\n")}\n${warmProbes} })();`,
  });
  const url = values["full-uuid-route"]
    ? new URL(
        `/${face}/main/${fixture.selectedSessionKey.split(":").at(-1)!.replaceAll("-", "")}`,
        server.baseUrl,
      ).href
    : values["short-route"]
      ? new URL(controlUiSessionPath(fixture.selectedSessionKey, "", face), server.baseUrl).href
      : controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey, face);
  async function settle() {
    try {
      await page.locator(".chat-pane__header").first().waitFor();
      if (values["session-event-ancestor-refs"]) {
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${fixture.scenario.sessions![2]!.key}"]`,
          )
          .waitFor({ state: "visible" });
      }
      await page
        .locator('.sidebar-rail [data-sidebar-entry^="session:"]')
        .nth(29)
        .waitFor({ state: "attached" });
      await page.locator('[data-sidebar-entry="plugin:team-scale-7/overview"]').waitFor();
      if (sidebarView === "online") {
        await page.locator('[data-online-user-id="team-person-120"]').waitFor();
      }
      if (face === "dashboard") {
        await page
          .frameLocator(
            values["dashboard-mcp-app"]
              ? "openclaw-board-view mcp-app-view iframe"
              : ".board-widget__frame",
          )
          .frameLocator("iframe")
          .getByText("Team metric 1", { exact: true })
          .waitFor();
      }
      await page
        .frameLocator(".chat-tool-card__preview-frame")
        .last()
        .frameLocator("iframe")
        .getByText("Team metric 12", { exact: true })
        .waitFor();
      if (face === "dashboard") {
        await page.waitForFunction(() => {
          const ready = Reflect.get(window, "__readWidgetReadiness")();
          return ready.firstBoardReadyMs !== null;
        });
      }
      if (face === "dashboard" && values["dashboard-widget"]) {
        await page.waitForFunction(() => {
          const stages = Reflect.get(window, "__readWidgetReadiness")().dashboardStages;
          return stages.appReadyMs !== null && stages.fontLoaded;
        });
      }
      await page.waitForFunction(
        (eventCount) => {
          const state = Reflect.get(window, "__coldLoad")?.read();
          return (
            state &&
            state.sentEvents === eventCount &&
            !state.pending &&
            !state.queued &&
            state.idleMs > 750
          );
        },
        fixture.events.length,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        ...Reflect.get(window, "__coldLoad")?.read(),
        widgetReadiness: Reflect.get(window, "__readWidgetReadiness")?.(),
      }));
      await writeFile(
        path.join(artifactDir, "failure.json"),
        JSON.stringify({ diagnostics, errors }, null, 2),
      );
      await page.screenshot({ path: path.join(artifactDir, "failure.png") });
      console.error(JSON.stringify({ diagnostics, errors }));
      throw error;
    }
  }
  await page.goto(url);
  try {
    await page.locator("#sidebar-session-owner-title").click();
    await page
      .locator(
        `.sidebar-session-owner-filter [role="option"][data-value="${values["session-event-ancestor-refs"] ? "all" : "involving-me"}"]`,
      )
      .click();
  } catch (error) {
    await writeFile(
      path.join(artifactDir, "setup-failure.json"),
      JSON.stringify({
        errors,
        sidebar: await page.locator("openclaw-app-sidebar").textContent(),
        diagnostics: await page.evaluate(() => Reflect.get(window, "__coldLoad")?.read()),
      }),
    );
    await page.screenshot({ path: path.join(artifactDir, "setup-failure.png") });
    throw error;
  }
  if (sidebarView === "online") {
    await page.locator('[data-navigation-view="online"]').click();
  }
  await settle();
  if (values["chat-dashboard-route"] || (face === "dashboard" && values["dashboard-widget"])) {
    // Save the operator's dashboard-first layout through its normal action.
    await page.locator("button.chat-pane__layout-trigger:not([inert] *)").first().click();
    const menu = page.locator(".chat-pane__layout-menu");
    await menu
      .getByRole("menuitem", { name: /^Swap / })
      .or(menu.getByRole("menuitemcheckbox", { name: /^Swap / }))
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("openclaw-board-view")
          ?.closest("[data-region]")
          ?.getAttribute("data-region") === "main",
    );
    if (values["chat-dashboard-route"]) {
      await page.evaluate(
        (deepLink) => history.replaceState(null, "", deepLink),
        controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey, "chat"),
      );
    }
    await settle();
  }
  await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
  const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
    sessionKey: fixture.selectedSessionKey,
    sidebarView: sidebarView === "online" ? "online" : "sessions",
  };
  const { storage: warmStorage, ...snapshotSave } = await page.evaluate(
    persistColdLoadWarmState,
    warmInput,
  );
  const warmStates = [warmStorage];
  const snapshotSaves = [snapshotSave];
  for (let index = 1; index < bundleSlots.length; index++) {
    await restoreColdLoadWarmState(page, warmStorage);
    await selectComparisonBundle(index);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle();
    const { storage, ...saved } = await page.evaluate(persistColdLoadWarmState, warmInput);
    warmStates.push(storage);
    snapshotSaves.push(saved);
  }
  await selectComparisonBundle(0);
  for (let run = 0; run < runs; run++) {
    const cpuPhases: Record<string, ColdLoadCpuTables> = {};
    async function recordCpu(phase: string, profile: Parameters<typeof mapColdLoadCpuProfile>[0]) {
      const mapped = await mapColdLoadCpuProfile(profile, {
        assetBaseUrl: new URL("assets/", server.baseUrl).href,
        assetDirectory: path.join(bundleDir, "assets"),
      });
      const summary = summarizeCpuProfile(mapped.profile, { includeTables: true });
      const tables = summary.tables!;
      cpuPhases[phase] = tables;
      (cpuRuns[phase] ??= []).push(tables);
      console.log(
        formatCpuTables(`Run ${run + 1} ${phase} CPU (profiled; timings inflated)`, tables),
      );
      console.log(
        `Mapped frames: ${mapped.mappedFrames}; unmapped asset frames: ${mapped.unmappedFrames}; sampled: ${summary.sampledMs.toFixed(1)} ms; idle: ${summary.idleMs.toFixed(1)} ms`,
      );
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.${phase}.cpuprofile`),
        JSON.stringify(mapped.profile),
      );
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.cpu-profile.json`),
        JSON.stringify(cpuPhases, null, 2),
      );
      return { ...mapped, summary };
    }
    const bundleIndex = run % bundleSlots.length;
    await restoreColdLoadWarmState(page, warmStates[bundleIndex]!);
    await selectComparisonBundle(bundleIndex);
    runTransfer =
      sidebarRowTransfer === "delta" || (sidebarRowTransfer === "interleaved" && run % 2 === 1)
        ? "delta"
        : "full";
    const cdp = await context.newCDPSession(page);
    const rawTrace: unknown[] = [];
    let collectedTrace = rawTrace;
    cdp.on("Tracing.dataCollected", (data) => collectedTrace.push(...data.value));
    if (cpuProfile) {
      await cdp.send("Performance.enable");
    }
    if (!values.untraced || cpuProfile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
      await cdp.send("Profiler.start");
    }
    if (!values.untraced) {
      await cdp.send("Tracing.start", {
        categories:
          "toplevel,loading,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.screenshot,v8",
        transferMode: "ReportEvents",
      });
    }
    sidebarLists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle();
    if (captureMs) {
      await page.waitForFunction((duration) => performance.now() >= duration, captureMs);
    }
    const metrics = await page.evaluate(() => {
      const pane = document.querySelector(".chat-pane-cache__pane--active");
      const rows = pane ? [...pane.querySelectorAll(".chat-virtual-row")] : null;
      return {
        ...Reflect.get(window, "__coldLoad").read(),
        widgetReadiness: Reflect.get(window, "__readWidgetReadiness")(),
        finalTranscript: {
          rows: rows?.length ?? null,
          rowKeys: rows?.map((row) => row.getAttribute("data-virtual-row-key")) ?? null,
          sessionKey: pane ? Reflect.get(pane, "sessionKey") : null,
          ready: pane ? Reflect.get(pane, "transcriptReady") === true : false,
        },
      };
    });
    const warmReload = values["warm-reload"]
      ? await page.evaluate(() => Reflect.get(window, "__warmReload").read())
      : undefined;
    if (cpuProfile) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.cpu-clock.json`),
        JSON.stringify((await cdp.send("Performance.getMetrics")).metrics),
      );
    }
    await writeFile(path.join(artifactDir, `run-${run + 1}.metrics.json`), JSON.stringify(metrics));
    const profile = values.untraced && !cpuProfile ? undefined : await cdp.send("Profiler.stop");
    if (!values.untraced) {
      const complete = new Promise<void>((resolve) => {
        cdp.once("Tracing.tracingComplete", () => resolve());
      });
      await cdp.send("Tracing.end");
      await complete;
    }
    await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.png`) });
    await writeFile(
      path.join(artifactDir, `run-${run + 1}.trace.json`),
      JSON.stringify({ traceEvents: rawTrace }),
    );
    if (profile) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.cpuprofile`),
        JSON.stringify(profile.profile),
      );
    }
    if (rigProbeScript) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.probes.json`),
        JSON.stringify(await page.evaluate(readRigProbeSnapshot)),
      );
    }
    const trace = rawTrace.map(prepareColdLoadTraceEvent);
    const screenshots = trace.flatMap((event) =>
      event.name === "Screenshot" && event.args?.snapshot
        ? [{ ts: event.ts, data: event.args.snapshot }]
        : [],
    );
    if (values["warm-reload"] && screenshots.length) {
      await mkdir(path.join(artifactDir, `run-${run + 1}.filmstrip`));
      for (const [index, frame] of screenshots.entries()) {
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.filmstrip`, `${index}-${frame.ts}.jpg`),
          Buffer.from(frame.data, "base64"),
        );
      }
    }
    const visual = await page.evaluate(async (frames) => {
      const canvas = document.createElement("canvas");
      canvas.width = 344;
      canvas.height = 236;
      const ctx = canvas.getContext("2d")!;
      let previous: DataView | undefined;
      let lastChange: number | undefined;
      let significantFrames = 0;
      let transitionGroups = 0;
      for (const frame of frames) {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${frame.data}`;
        await image.decode();
        ctx.drawImage(image, 0, 0, 344, 236);
        const bytes = ctx.getImageData(0, 0, 344, 236).data;
        const pixels = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (previous) {
          let changed = 0;
          for (let i = 0; i < pixels.byteLength; i += 4) {
            if (
              Math.max(
                Math.abs(pixels.getUint8(i) - previous.getUint8(i)),
                Math.abs(pixels.getUint8(i + 1) - previous.getUint8(i + 1)),
                Math.abs(pixels.getUint8(i + 2) - previous.getUint8(i + 2)),
              ) >= 32
            ) {
              changed++;
            }
          }
          if (changed / (344 * 236) >= 0.004) {
            significantFrames++;
            if (lastChange === undefined || frame.ts - lastChange > 100_000) {
              transitionGroups++;
            }
            lastChange = frame.ts;
          }
        }
        previous = pixels;
      }
      return {
        frames: frames.length,
        significantFrames,
        transitionGroups,
      };
    }, screenshots);
    const mapped = !profile
      ? undefined
      : cpuProfile
        ? await recordCpu("reload", profile.profile)
        : values["sidebar-list-churn"]
          ? {
              profile: profile.profile,
              mappedFrames: 0,
              unmappedFrames: profile.profile.nodes.length,
            }
          : await mapColdLoadCpuProfile(profile.profile, {
              assetBaseUrl: new URL("assets/", server.baseUrl).href,
              assetDirectory: path.join(bundleDir, "assets"),
            });
    let streaming;
    if (streamingReply) {
      const composer = page.locator(".agent-chat__composer-combobox textarea").last();
      await composer.focus();
      await cdp.send("Performance.enable");
      let previousCpu = (await cdp.send("Performance.getMetrics")).metrics;
      let previousDelivered = 0;
      const cpu: Array<{
        delivered: number;
        deltas: number;
        milliseconds: Record<string, number>;
      }> = [];
      if (cpuProfile) {
        await cdp.send("Profiler.start");
      }
      await page.evaluate((input) => Reflect.get(window, "__streamingReply").start(input), {
        ...streamingReply,
        sessionKey: fixture.selectedSessionKey,
        runId: fixture.scenario.inFlightRun!.runId,
      });
      const streamingInput = new AbortController();
      const nativeInput = (async () => {
        while (!streamingInput.signal.aborted) {
          await page.keyboard.press("x");
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
        }
      })();
      try {
        for (let quartile = 1; quartile <= 4; quartile++) {
          await page.waitForFunction(
            (count) => Reflect.get(window, "__streamingReply").read().delivered >= count,
            Math.floor((streamingReply.deltas.length * quartile) / 4),
            { timeout: 60_000 },
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          const nextCpu = (await cdp.send("Performance.getMetrics")).metrics;
          const delivered = await page.evaluate(
            () => Reflect.get(window, "__streamingReply").read().delivered,
          );
          cpu.push({
            delivered,
            deltas: delivered - previousDelivered,
            milliseconds: Object.fromEntries(
              ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                (name) => [
                  name,
                  1000 *
                    (nextCpu.find((metric) => metric.name === name)!.value -
                      previousCpu.find((metric) => metric.name === name)!.value),
                ],
              ),
            ),
          });
          previousCpu = nextCpu;
          previousDelivered = delivered;
        }
      } finally {
        streamingInput.abort();
        await nativeInput;
      }
      if (cpuProfile) {
        await recordCpu("streaming", (await cdp.send("Profiler.stop")).profile);
      }
      streaming = {
        ...(await page.evaluate(() => Reflect.get(window, "__streamingReply").finish())),
        cpu,
      };
      if (!streaming.finalHtml) {
        throw new Error("Streaming reply produced no visible Markdown");
      }
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.streaming.json`),
        JSON.stringify(
          {
            head,
            chars: streamingReply.text.length,
            deltasPerSecond: streamingReply.deltasPerSecond,
            ...streaming,
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.streaming.png`) });
    }
    let live;
    const readLivePresentation = () =>
      page.evaluate(
        (keys) => {
          const rows = Object.fromEntries(
            keys.map((key) => {
              const row = document.querySelector<HTMLElement>(
                `openclaw-app-sidebar [data-session-key="${key}"]`,
              );
              const rect = row?.getBoundingClientRect();
              return [
                key,
                {
                  attached: Boolean(row),
                  inViewport: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight),
                  text: row?.textContent?.trim() ?? null,
                  classes: row?.className ?? null,
                },
              ];
            }),
          );
          return {
            rows,
            viewers: [...document.querySelectorAll("openclaw-chat-pane [data-viewer-id]")].map(
              (element) => element.getAttribute("data-viewer-id"),
            ),
            streamingText:
              document.querySelector("openclaw-chat-pane .chat-bubble.streaming")?.textContent ??
              null,
          };
        },
        [
          fixture.scenario.sessions![0]!.key,
          fixture.scenario.sessions![119]!.key,
          fixture.scenario.sessions![160]!.key,
          fixture.scenario.sessions![240]!.key,
        ],
      );
    if (values["live-events"]) {
      if (liveStartAtMs !== undefined) {
        const remainingMs = liveStartAtMs - Date.now();
        if (remainingMs < 0) {
          throw new Error("Missed paired live-start barrier");
        }
        await new Promise((resolve) => {
          setTimeout(resolve, Math.max(0, remainingMs));
        });
      }
      const before = await readLivePresentation();
      await cdp.send("Performance.enable");
      const cpuBefore = (await cdp.send("Performance.getMetrics")).metrics;
      const liveTrace: unknown[] = [];
      collectedTrace = liveTrace;
      if (!values.untraced || cpuProfile) {
        await cdp.send("Profiler.start");
      }
      if (!values.untraced) {
        await cdp.send("Tracing.start", {
          categories:
            "toplevel,blink.user_timing,devtools.timeline,disabled-by-default-v8.cpu_profiler",
          transferMode: "ReportEvents",
        });
      }
      const listOffset = sidebarLists?.stats().length ?? 0;
      await page.evaluate((captureProbes) => {
        if (captureProbes) {
          const read = Reflect.get(window, "__readColdLoadRigProbes");
          Reflect.set(window, "__coldLoadRigLiveStart", read());
          setTimeout(() => Reflect.set(window, "__coldLoadRigLateStart", read()), 5_000);
          setTimeout(() => Reflect.set(window, "__coldLoadRigQuietStart", read()), 15_000);
        }
        Reflect.get(window, "__coldLoad").startLive();
      }, Boolean(rigProbeScript));
      await page.waitForFunction(
        (count) => Reflect.get(window, "__coldLoad").readLive().sentEvents === count,
        fixture.liveEvents.length,
        { timeout: Math.max(35_000, fixture.liveEvents.at(-1)!.atMs + 5_000) },
      );
      const plannedWindowMs =
        fixture.liveEvents.at(-1)!.atMs + (values["sidebar-list-churn"] ? 16_000 : 750);
      await page.waitForFunction(
        (windowMs) => Reflect.get(window, "__coldLoad").readLive().elapsedMs >= windowMs,
        plannedWindowMs,
      );
      if (values["sidebar-list-churn"]) {
        try {
          await page.waitForFunction(() => {
            const state = Reflect.get(window, "__coldLoad").read();
            return !state.pending && !state.queued;
          });
        } catch (error) {
          await writeFile(
            path.join(artifactDir, `run-${run + 1}.live-failure.json`),
            JSON.stringify({
              error: String(error),
              metrics: await page.evaluate(() => Reflect.get(window, "__coldLoad").read()),
              live: await page.evaluate(() => Reflect.get(window, "__coldLoad").readLive()),
              sidebarLists: sidebarLists?.stats().slice(listOffset),
            }),
          );
          throw error;
        }
      }
      await page.evaluate(() => Reflect.get(window, "__coldLoad").finishLive());
      const cpuAfter = (await cdp.send("Performance.getMetrics")).metrics;
      if (!values.untraced || cpuProfile) {
        const liveProfile = await cdp.send("Profiler.stop");
        if (cpuProfile) {
          await recordCpu("live", liveProfile.profile);
        } else {
          await writeFile(
            path.join(artifactDir, `run-${run + 1}.live.cpuprofile`),
            JSON.stringify(liveProfile.profile),
          );
        }
      }
      if (!values.untraced) {
        const liveComplete = new Promise<void>((resolve) => {
          cdp.once("Tracing.tracingComplete", () => resolve());
        });
        await cdp.send("Tracing.end");
        await liveComplete;
      }
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.live.trace.json`),
        JSON.stringify({ traceEvents: liveTrace }),
      );
      const after = await readLivePresentation();
      const ancestorLink = page.locator(
        `.sidebar-rail [data-sidebar-entry="session:${fixture.selectedSessionKey}"] a`,
      );
      const ancestorBaseline = values["session-event-ancestor-refs"]
        ? {
            text: await ancestorLink.getAttribute("aria-label"),
            visible: await ancestorLink.isVisible(),
            socketCount: await page.evaluate(() =>
              Reflect.get(window, "openclawControlUiE2eGateway").socketCount(),
            ),
          }
        : undefined;
      if (
        ancestorBaseline &&
        (!ancestorBaseline.text?.includes("Synthetic ancestor baseline verified") ||
          !ancestorBaseline.visible ||
          ancestorBaseline.socketCount !== 1)
      ) {
        throw new Error("Ancestor-reference replay lost its raw baseline or rendered outcome");
      }
      const liveMetrics = await page.evaluate(() => Reflect.get(window, "__coldLoad").readLive());
      // Independent coordinators drift; pair request starts within half their minimum cooldown.
      const pairedRefreshes = values["sidebar-list-churn"]
        ? liveMetrics.rpcs.filter(
            (rpc: LiveRpc) =>
              rpc.method === "sessions.list" &&
              sidebarWindow(rpc.params) === "ownerFirst" &&
              rpc.params.ifRowsRevision !== undefined &&
              requestedAtMs(rpc) >= 6000 &&
              liveMetrics.rpcs.some(
                (other: LiveRpc) =>
                  other.method === "sessions.list" &&
                  sidebarWindow(other.params) === "involvingMe" &&
                  other.params.ifRowsRevision !== undefined &&
                  Math.abs(requestedAtMs(other) - requestedAtMs(rpc)) < 2500,
              ),
          ).length
        : undefined;
      const activeStreamMs = fixture.liveEvents.at(-1)!.atMs;
      const sidebarReads = sidebarLists?.stats().slice(listOffset);
      const responseTasks = summarizeResponseTasks(liveTrace);
      live = {
        ...liveMetrics,
        ancestorBaseline,
        milliseconds: Object.fromEntries(
          ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
            (name) => [
              name,
              1000 *
                (cpuAfter.find((metric) => metric.name === name)!.value -
                  cpuBefore.find((metric) => metric.name === name)!.value),
            ],
          ),
        ),
        head,
        sidebarRowTransfer: values["sidebar-list-churn"] ? runTransfer : undefined,
        sidebarLists: sidebarReads,
        sidebarWindows:
          sidebarReads && !values.untraced
            ? summarizeSidebarWindows(
                liveMetrics.rpcs,
                liveMetrics.rpcOffset,
                sidebarReads,
                responseTasks,
                activeStreamMs,
                liveMetrics.elapsedMs,
              )
            : undefined,
        pairedRefreshes,
        pairingMeasurement:
          "Conditional request starts after six seconds, paired within half the five-second minimum cooldown; response arrival skew is separate.",
        responseTasks,
        activeStreamMs,
        rateMeasurement:
          "Observed rates use the complete capture including drain; active-stream-normalized rates charge trailing coalesced reads to the event stream.",
        plannedWindowMs,
        presentation: { before, after },
        probes: rigProbeScript
          ? await page.evaluate(() => ({
              start: Reflect.get(window, "__coldLoadRigLiveStart"),
              lateStart: Reflect.get(window, "__coldLoadRigLateStart"),
              quietStart: Reflect.get(window, "__coldLoadRigQuietStart"),
              end: Reflect.get(window, "__readColdLoadRigProbes")(),
            }))
          : undefined,
      };
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.live.png`) });
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.live.json`),
        JSON.stringify(live, null, 2),
      );
      if (pairedRefreshes !== undefined && pairedRefreshes < 3) {
        throw new Error(
          `Sidebar churn reproduced ${pairedRefreshes} sustained conditional sidebar pairs; expected at least three`,
        );
      }
    }
    const overlays = values["overlay-probe"]
      ? await probeColdLoadOverlays(
          page,
          artifactDir,
          run,
          values["closed-menu-members"]
            ? [
                ["sharing", ".chat-pane__sharing-trigger", ".chat-pane__sharing-member"],
                ["layout", ".chat-pane__layout-trigger", ".chat-pane__layout-menu .oc-menu-item"],
              ]
            : undefined,
        )
      : undefined;
    let sessionSwitch;
    if (values["session-switch"]) {
      if (sidebarView !== "sessions") {
        await page.locator('[data-navigation-view="sessions"]').click();
      }
      const target = fixture.scenario.sessions![1]!;
      const link = page.locator(
        `.sidebar-recent-session[data-session-key="${target.key}"] a.sidebar-recent-session__link`,
      );
      await link.waitFor({ state: "visible" });
      const rpcOffset = await page.evaluate(
        () => Reflect.get(window, "__coldLoad").read().rpcs.length,
      );
      await cdp.send("Performance.enable");
      const cpuBefore = (await cdp.send("Performance.getMetrics")).metrics;
      if (cpuProfile) {
        await cdp.send("Profiler.start");
      }
      const started = await page.evaluate(() => performance.now());
      await link.click();
      await page.waitForFunction(
        (key) =>
          [...document.querySelectorAll("openclaw-chat-pane")].some(
            (pane) => Reflect.get(pane, "sessionKey") === key,
          ),
        target.key,
      );
      await page.locator(".chat-tool-card__preview-frame").last().waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const state = Reflect.get(window, "__coldLoad").read();
        return !state.pending && !state.queued && state.idleMs > 750;
      });
      const elapsedMs = await page.evaluate((start) => performance.now() - start, started);
      const cpuAfter = (await cdp.send("Performance.getMetrics")).metrics;
      if (cpuProfile) {
        await recordCpu("session-switch", (await cdp.send("Profiler.stop")).profile);
      }
      sessionSwitch = {
        from: fixture.selectedSessionKey,
        to: target.key,
        elapsedMs,
        milliseconds: Object.fromEntries(
          ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
            (name) => [
              name,
              1000 *
                (cpuAfter.find((metric) => metric.name === name)!.value -
                  cpuBefore.find((metric) => metric.name === name)!.value),
            ],
          ),
        ),
        rpcs: await page.evaluate(
          (offset) => Reflect.get(window, "__coldLoad").read().rpcs.slice(offset),
          rpcOffset,
        ),
      };
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.session-switch.png`) });
    }
    await cdp.detach();
    const result = {
      run: run + 1,
      ...(comparisonBundleDirs.length
        ? { variant: ["base", "candidate", "candidate-2"][activeBundle] }
        : {}),
      head,
      sidebarRowTransfer: values["sidebar-list-churn"] ? runTransfer : undefined,
      ...metrics,
      trace: values.untraced ? undefined : summarizeColdLoadTrace(trace, metrics.at),
      cpu: mapped ? summarizeCpuProfile(mapped.profile) : undefined,
      mappedFrames: mapped?.mappedFrames,
      unmappedFrames: mapped?.unmappedFrames,
      harnessWarnings,
      visual,
      live,
      streaming,
      sessionSwitch,
      warmReload,
      snapshotSave: snapshotSaves[bundleIndex],
      overlays,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  if (errors.length) {
    throw new Error(`Browser errors: ${errors.join("\n")}`);
  }
  if (cpuProfile) {
    const median = Object.fromEntries(
      Object.entries(cpuRuns).map(([phase, tables]) => [phase, medianCpuTables(tables)]),
    );
    await writeFile(path.join(artifactDir, "cpu-profile.json"), JSON.stringify(median, null, 2));
    const comparisons: Record<string, ReturnType<typeof compareCpuTables>> = {};
    for (const [phase, tables] of Object.entries(median)) {
      console.log(
        formatCpuTables(
          `Median ${phase} CPU (${runs} profiled runs; missing functions count as zero)`,
          tables,
        ),
      );
      if (baselineCpu) {
        // SAFETY: Baseline phases were validated against the enabled benchmark phases.
        comparisons[phase] = compareCpuTables(baselineCpu[phase]!, tables);
        console.log(
          formatCpuTables(
            `${phase} CPU delta (candidate minus baseline)`,
            { functions: comparisons[phase], files: [] },
            true,
          ),
        );
      }
    }
    if (baselineCpu) {
      await writeFile(
        path.join(artifactDir, "cpu-profile-compare.json"),
        JSON.stringify(comparisons, null, 2),
      );
    }
  }
  await context.close();
} finally {
  await browser?.close();
  await selectComparisonBundle(0);
  await server.close();
  sandbox.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    sandbox.close((error) => (error ? reject(error) : resolve()));
  });
  await writeFile(
    path.join(artifactDir, "summary.json"),
    JSON.stringify(
      {
        head,
        buildId,
        dirty,
        bundleDir,
        comparisonBundleDirs,
        fixture: fixture.counts,
        sidebarView,
        streamingReply: values["streaming-reply"],
        sessionSwitch: values["session-switch"],
        sidebarListChurn: values["sidebar-list-churn"],
        sidebarLiveChurn: fixture.sidebarLiveChurn,
        duplicateBootReads: values["duplicate-boot-reads"],
        dashboardMcpApp: values["dashboard-mcp-app"],
        chatDashboardRoute: values["chat-dashboard-route"],
        traced: !values.untraced,
        cpuProfile,
        cpuProfileCompare: values["cpu-profile-compare"],
        sidebarRowTransfer,
        sidebarComparison: values["sidebar-list-churn"]
          ? "Same final client bundle; full/delta wire response A/B using the production presenter and one synthetic query/history owner. This does not measure real Gateway selection, history reset/fallback lifecycle, or server projection CPU. Node IPC is outside the measured application response task."
          : undefined,
        latencyMs,
        methodLatencyMs,
        connectNotBeforeMs,
        dashboardWidget: values["dashboard-widget"],
        face,
        shortRoute: values["short-route"],
        fullUuidRoute: values["full-uuid-route"],
        frameGapMs,
        captureMs,
        sessionEventDurationMs,
        sessionEventAncestorRefs: values["session-event-ancestor-refs"],
        fixtureNowMs,
        liveStartAtMs,
        port,
        sandboxPort,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Cold-load artifacts: ${artifactDir}`);
}
