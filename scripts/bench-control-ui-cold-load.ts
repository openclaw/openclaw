// Opt-in production-bundle benchmark; real delays model wire delivery, not test synchronization.
// --cpu-profile: source-mapped reload/live/streaming tables and per-run/median cpu-profile.json.
// --thread-cpu-time excludes renderer descheduling from CDP duration metrics.
// Traces report coarse V8 module parse/compile CPU, not exhaustive compiler CPU.
// javaScriptResources includes completed modulepreloads absent from V8 coverage.
// --cpu-profile-compare <baseline cpu-profile.json>: profile and diff against that report.
// --selector-stats: ranked boot CSS selectors (instrumentation overhead included).
// --viewport desktop|mobile: 1719×1179 (default) or 390×844 browser viewport.
// --allocations --untraced --live-events: collected-object renderer bytes per event.
// --streaming-allocations: sampled allocation bytes including collected objects during deltas.
// Sampling inflates timings: never compare profiled runs with unprofiled runs.
// --session-event-duration-ms 135000 --session-event-ancestor-refs extends the native churn.
// Pair built bundles with --fixture-now-ms and --live-start-at-ms (one run per process).
// OPENCLAW_CONTROL_UI_BUILD_ID supplies the matching identity outside a Git checkout.
// --gateway-url uses real Gateway HTTP serving with synthetic bootstrap/RPC fixtures.
// --gateway-http serves paired bundles, including layout cells, through the Gateway HTTP owner.
// --first-load skips warm-up and clears client state; external Gateway URL runs stay single-sample.
// --sidebar-persistent-children keeps expanded rows outside root windows for staggered handoff proof.
// --boot-route chat|new|sessions|settings selects the measured reload destination.
// --layout-matrix covers routes, themes, viewports and cold/warm reloads; --runs is per bundle/cell.
// Repeat --layout-cell mobile:light:chat:cold to isolate cells with their matrix setup intact.
// --critical-path captures usable-screen readiness and first Sessions/Settings/Cron/Agents visits.
// Repeat --critical-path-route to narrow/order visits; HTTP throttling and RPC latency are separate.
// --critical-path-intent-ms 150 includes hover/focus prefetch before route activation.
// --settings-core-schema replays the server's core config schema, prepared before sampling.
// Paint/CLS and static-shell geometry are recorded in presentation; --filmstrip-only saves frames.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../src/gateway/control-ui-bootstrap-contract.ts";
import { captureSessionRowGeneration } from "../src/gateway/session-row-identity.js";
import { shareSidebarSessionRows } from "../src/gateway/session-row-presentation.js";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import { isChatHistoryState } from "../ui/src/lib/protocol-validators.generated/history-state.js";
import { createColdLoadProbeInitScript } from "../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  createControlUiMockBootstrapConfig,
  installControlUiMockBootstrapDocument,
  createControlUiMockGatewayInitScript,
  controlUiSessionPath,
  controlUiSessionUrl,
  controlUiBundledSettingsStorageKey,
  prepareControlUiMockGatewayScenario,
  resolvePlaywrightChromiumExecutablePath,
  startProductionControlUiE2eServer,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../ui/src/test-helpers/control-ui-navigation.ts";
import { createControlUiSandboxFixtureServer } from "../ui/src/test-helpers/control-ui-sandbox-fixture-server.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  createControlUiStreamingReply,
  createStreamingReplyProbeInitScript,
} from "../ui/src/test-helpers/control-ui-streaming-reply.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { resolveColdLoadLatency } from "./lib/control-ui-bench-latency.ts";
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
  summarizeScriptCoverage,
  summarizeJavaScriptResources,
  summarizeCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import {
  renderCriticalPathWaterfall,
  type CriticalPathHttpRequest,
} from "./lib/control-ui-critical-path-waterfall.ts";
import {
  criticalPathRoutes,
  criticalPathCpuDelta,
  installCriticalPathProbe,
  navigateCriticalPath,
  readCriticalPath,
  readCriticalPathCpu,
  type CriticalPathPresentation,
  type CriticalPathRoute,
} from "./lib/control-ui-critical-path.ts";
import {
  installRotatingBoardTickets,
  installWidgetReadiness,
} from "./lib/control-ui-dashboard-probe.ts";
import {
  summarizeInteractionSelectors,
  summarizeLongTaskCpuProfiles,
  type InteractionStyleSheet,
} from "./lib/control-ui-interaction-trace.ts";
import { probeColdLoadOverlays } from "./lib/control-ui-overlay-probe.ts";
import { installPaneChromeProbe } from "./lib/control-ui-pane-chrome-probe.ts";
import { warmReloadProbe } from "./lib/control-ui-warm-reload-probe.ts";
import {
  GATEWAY_HEAP_SAMPLE_INTERVAL,
  readGatewayHeapProfile,
} from "./lib/gateway-bench-profile.ts";

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
    "selector-stats": { type: "boolean", default: false },
    "cpu-profile-compare": { type: "string" },
    "thread-cpu-time": { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    "warm-reload": { type: "boolean", default: false },
    "row-facts": { type: "boolean", default: false },
    "pane-chrome-probe": { type: "boolean", default: false },
    "large-snapshot": { type: "boolean", default: false },
    "dashboard-widget": { type: "boolean", default: false },
    "connect-not-before-ms": { type: "string" },
    "latency-profile": { type: "string" },
    "transcript-messages": { type: "string" },
    "overlay-probe": { type: "boolean", default: false },
    untraced: { type: "boolean", default: false },
    "filmstrip-only": { type: "boolean", default: false },
    "layout-matrix": { type: "boolean", default: false },
    "layout-route": { type: "string", multiple: true, default: [] },
    "layout-cell": { type: "string", multiple: true, default: [] },
    "layout-start": { type: "string", default: "0" },
    "hold-boot-assets": { type: "boolean", default: false },
    "history-validator-delay-ms": { type: "string", default: "0" },
    "dashboard-paint-marker": { type: "boolean", default: false },
    "color-scheme": { type: "string" },
    viewport: { type: "string", default: "desktop" },
    "probe-dir": { type: "string" },
    "live-events": { type: "boolean", default: false },
    "streaming-reply": { type: "boolean", default: false },
    "streaming-allocations": { type: "boolean", default: false },
    "streaming-burst-size": { type: "string", default: "1" },
    "streaming-rate": { type: "string", default: "30" },
    "session-switch": { type: "boolean", default: false },
    "critical-path": { type: "boolean", default: false },
    "critical-path-route": { type: "string", multiple: true, default: [] },
    "critical-path-intent-ms": { type: "string" },
    "settings-core-schema": { type: "boolean", default: false },
    "init-script": { type: "string", multiple: true, default: [] },
    "sidebar-list-churn": { type: "boolean", default: false },
    "sidebar-live-churn": { type: "boolean", default: false },
    "sidebar-avatars": { type: "boolean", default: false },
    "transcript-avatars": { type: "boolean", default: false },
    "sidebar-expanded": { type: "boolean", default: false },
    "sidebar-persistent-children": { type: "boolean", default: false },
    "omit-hello-self-presence": { type: "boolean", default: false },
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
    "gateway-url": { type: "string" },
    "gateway-http": { type: "boolean", default: false },
    "first-load": { type: "boolean", default: false },
    "boot-route": { type: "string", default: "chat" },
    "cold-http-cache": { type: "boolean", default: false },
    coverage: { type: "boolean", default: false },
    "network-latency-ms": { type: "string" },
    "download-kbps": { type: "string" },
    "cpu-throttle": { type: "string" },
    port: { type: "string" },
    "sandbox-port": { type: "string" },
    "compare-bundle-dir": { type: "string", multiple: true, default: [] },
    runs: { type: "string", default: "3" },
    "latency-ms": { type: "string" },
    "method-latency-ms": { type: "string", multiple: true, default: [] },
    "sidebar-query-latency-ms": { type: "string", multiple: true, default: [] },
    face: { type: "string", default: "dashboard" },
    "short-route": { type: "boolean", default: false },
    "full-uuid-route": { type: "boolean", default: false },
    "off-roster-route": { type: "boolean", default: false },
    "frame-gap-ms": { type: "string" },
    "sidebar-view": { type: "string", default: "sessions" },
    output: { type: "string", default: ".artifacts/control-ui-cold-load" },
  },
});
if (values["pane-chrome-probe"] && !values["warm-reload"]) {
  throw new Error("pane-chrome-probe requires warm-reload for the first transcript paint boundary");
}
if (values["selector-stats"] && (values.untraced || values["filmstrip-only"])) {
  throw new Error("selector-stats requires tracing; exclude untraced and filmstrip-only");
}
if (values["streaming-reply"] && values["live-events"]) {
  throw new Error("streaming-reply measures an isolated answer; do not combine with live-events");
}
if (values["streaming-allocations"] && !values["streaming-reply"]) {
  throw new Error("streaming-allocations requires streaming-reply");
}
if (values["sidebar-list-churn"] && !values["live-events"]) {
  throw new Error("sidebar-list-churn requires live-events");
}
if (values["sidebar-list-churn"] && (values.untraced || values["filmstrip-only"])) {
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
const performanceTimeDomain = values["thread-cpu-time"] ? "threadTicks" : "timeTicks";
const allocations = values.allocations;
const traced = !values.untraced && !values["filmstrip-only"];
if (
  allocations &&
  (!values["live-events"] || !values.untraced || cpuProfile || values["filmstrip-only"])
) {
  throw new Error(
    "allocations requires untraced live-events without CPU profiling or filmstrip capture",
  );
}
const captureTrace = traced || values["filmstrip-only"];
const colorScheme = values["color-scheme"];
if (colorScheme !== undefined && colorScheme !== "light" && colorScheme !== "dark") {
  throw new Error("Expected color-scheme light or dark");
}
const viewportName = values.viewport;
if (viewportName !== "desktop" && viewportName !== "mobile") {
  throw new Error("Expected viewport desktop or mobile");
}
const viewport =
  viewportName === "mobile" ? { width: 390, height: 844 } : { width: 1719, height: 1179 };
if (values["filmstrip-only"] && cpuProfile) {
  throw new Error("filmstrip-only excludes CPU profiling");
}
const baselineCpu = values["cpu-profile-compare"]
  ? readCpuProfileReport(JSON.parse(await readFile(values["cpu-profile-compare"], "utf8")), [
      "reload",
      ...(values["live-events"] ? ["live"] : []),
      ...(values["streaming-reply"] ? ["streaming"] : []),
      ...(values["session-switch"] ? ["session-switch"] : []),
    ])
  : undefined;
const cpuRuns: Record<string, ColdLoadCpuTables[]> = {};
const layoutStart = Number(values["layout-start"]);
if (
  !Number.isInteger(layoutStart) ||
  layoutStart < 0 ||
  layoutStart > 31 ||
  values["layout-cell"].some(
    (cell) =>
      !/^(desktop|mobile):(light|dark):(chat|new|sessions|settings):(cold|warm)$/u.test(cell),
  ) ||
  values["layout-route"].some((route) => !["chat", "new", "sessions", "settings"].includes(route))
) {
  throw new Error(
    "Expected layout-start 0–31, a known layout-route, and layout-cell viewport:theme:route:cold|warm",
  );
}
if (
  values["layout-matrix"] &&
  (values["first-load"] || values["critical-path"] || values["gateway-url"])
) {
  throw new Error(
    "layout-matrix owns cold/warm setup and route readiness; exclude first-load, critical-path and external gateway-url modes",
  );
}
const layoutCells = values["layout-matrix"]
  ? (["desktop", "mobile"] as const)
      .flatMap((cellViewport) =>
        (["light", "dark"] as const).flatMap((cellColorScheme) =>
          (["chat", "new", "sessions", "settings"] as const).flatMap((route) =>
            [true, false].map((cold) => ({
              viewport: cellViewport,
              colorScheme: cellColorScheme,
              route,
              cold,
            })),
          ),
        ),
      )
      .filter(
        ({ route }) => !values["layout-route"].length || values["layout-route"].includes(route),
      )
      .filter(
        (cell) =>
          !values["layout-cell"].length ||
          values["layout-cell"].includes(
            `${cell.viewport}:${cell.colorScheme}:${cell.route}:${cell.cold ? "cold" : "warm"}`,
          ),
      )
      .slice(layoutStart)
  : [];
if (values["layout-matrix"] && !layoutCells.length) {
  throw new Error("Layout filters and layout-start must leave at least one matrix cell");
}
const layoutVariants = values["layout-matrix"] ? values["compare-bundle-dir"].length + 1 : 1;
const requestedRuns = Number(values.runs);
const runs = requestedRuns * (layoutCells.length || 1) * layoutVariants;
const gatewayUrl = values["gateway-url"] ? new URL(values["gateway-url"]) : undefined;
const firstLoad = values["first-load"];
if (
  values["hold-boot-assets"] &&
  (!firstLoad || runs !== 1 || !values["filmstrip-only"] || values["compare-bundle-dir"].length)
) {
  throw new Error("hold-boot-assets requires one first-load filmstrip-only run without comparison");
}
const bootRoute = values["boot-route"];
if (
  bootRoute !== "chat" &&
  bootRoute !== "new" &&
  bootRoute !== "sessions" &&
  bootRoute !== "settings"
) {
  throw new Error("Expected boot-route chat, new, sessions or settings");
}
const navigationRoutes: CriticalPathRoute[] = [];
// Cold New has no Chat owner to complete registration, so omit the unused WeakMap shim.
const captureOwnerRegistration = !firstLoad || bootRoute !== "new";
const ownerProbes =
  captureOwnerRegistration && !cpuProfile && !allocations && !values["session-event-churn"];
const sidebarCounters = captureOwnerRegistration && !cpuProfile;
for (const route of values["critical-path-route"]) {
  const matched = criticalPathRoutes.find((candidate) => candidate === route);
  if (!matched || navigationRoutes.includes(matched)) {
    throw new Error("critical-path-route must be a unique sessions, settings, cron or agents");
  }
  navigationRoutes.push(matched);
}
if (navigationRoutes.length && !values["critical-path"]) {
  throw new Error("critical-path-route requires critical-path");
}
const criticalPathIntentMs = Number(values["critical-path-intent-ms"] ?? 0);
if (!Number.isFinite(criticalPathIntentMs) || criticalPathIntentMs < 0) {
  throw new Error("critical-path-intent-ms must be a nonnegative number");
}
if (values["critical-path-intent-ms"] !== undefined && !values["critical-path"]) {
  throw new Error("critical-path-intent-ms requires critical-path");
}
if (values["critical-path"] && !navigationRoutes.length && bootRoute === "chat") {
  navigationRoutes.push(...criticalPathRoutes);
}
if (
  bootRoute !== "chat" &&
  (values["live-events"] ||
    values["session-switch"] ||
    values["streaming-reply"] ||
    values["overlay-probe"])
) {
  throw new Error("Non-chat boot routes exclude chat interaction phases");
}
const networkLatencyMs = Number(values["network-latency-ms"] ?? 0);
const downloadKbps = Number(values["download-kbps"] ?? 0);
const cpuThrottle = Number(values["cpu-throttle"] ?? 1);
if (
  (gatewayUrl &&
    (!["http:", "https:"].includes(gatewayUrl.protocol) ||
      gatewayUrl.username ||
      gatewayUrl.password ||
      gatewayUrl.search ||
      gatewayUrl.hash ||
      gatewayUrl.pathname !== "/" ||
      !firstLoad ||
      !values["bundle-dir"] ||
      runs !== 1 ||
      values["compare-bundle-dir"].length)) ||
  (firstLoad && values["warm-reload"]) ||
  (values["gateway-http"] && (gatewayUrl || !values["bundle-dir"])) ||
  (firstLoad && values["sidebar-view"] !== "sessions") ||
  !Number.isFinite(networkLatencyMs) ||
  networkLatencyMs < 0 ||
  !Number.isFinite(downloadKbps) ||
  downloadKbps < 0 ||
  !Number.isFinite(cpuThrottle) ||
  cpuThrottle < 1
) {
  throw new Error(
    "gateway-url requires an HTTP origin, bundle-dir and one first-load run without comparison; gateway-http requires bundle-dir without gateway-url; first-load requires sidebar-view=sessions without warm-reload; network limits must be nonnegative and cpu-throttle at least 1",
  );
}
const {
  latencyProfile,
  latencyMs,
  frameGapMs,
  connectNotBeforeMs,
  methodLatencyMs,
  sidebarQueryLatencyMs,
} = resolveColdLoadLatency({
  profile: values["latency-profile"],
  latencyMs: values["latency-ms"],
  frameGapMs: values["frame-gap-ms"],
  connectNotBeforeMs: values["connect-not-before-ms"],
  methodLatencyMs: values["method-latency-ms"],
  sidebarQueryLatencyMs: values["sidebar-query-latency-ms"],
});
const historyValidatorDelayMs = Number(values["history-validator-delay-ms"]);
if (
  !Number.isFinite(historyValidatorDelayMs) ||
  historyValidatorDelayMs < 0 ||
  historyValidatorDelayMs > 10_000 ||
  (historyValidatorDelayMs > 0 && !values["warm-reload"])
) {
  throw new Error("history-validator-delay-ms requires warm-reload and a delay from 0 to 10000");
}
const face = values.face;
if (face !== "chat" && face !== "dashboard") {
  throw new Error("Expected face chat or dashboard");
}
if (values["chat-dashboard-route"] && face !== "dashboard") {
  throw new Error("chat-dashboard-route requires the dashboard face");
}
const captureMs = Number(values["capture-ms"]);
const transcriptMessages =
  values["transcript-messages"] === undefined ? undefined : Number(values["transcript-messages"]);
const streamingBurstSize = Number(values["streaming-burst-size"]);
const streamingRate = Number(values["streaming-rate"]);
if (!Number.isFinite(streamingRate) || streamingRate <= 0) {
  throw new Error("streaming-rate must be a positive number of deltas per second");
}
if (
  !Number.isSafeInteger(streamingBurstSize) ||
  streamingBurstSize < 1 ||
  streamingBurstSize > 30
) {
  throw new Error("streaming-burst-size must be between 1 and 30");
}
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
  !Number.isInteger(requestedRuns) ||
  requestedRuns < 1 ||
  requestedRuns > (values["compare-bundle-dir"].length ? 60 : 20) ||
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
    traced ||
    cpuProfile ||
    values["compare-bundle-dir"].length > 2 ||
    runs % (values["compare-bundle-dir"].length + 1))
) {
  throw new Error("Bundle comparison requires complete cycles of two or three unprofiled bundles");
}
if (sidebarRowTransfer === "interleaved" && (runs < 14 || runs % 2 !== 0)) {
  throw new Error("Interleaved sidebar transfer requires an even run count of at least 14");
}
if (
  liveStartAtMs !== undefined &&
  (runs !== 1 || (!values["live-events"] && !values["streaming-reply"]))
) {
  throw new Error("live-start-at-ms requires one live-events or streaming-reply run");
}
const artifactDir = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
await mkdir(artifactDir, { recursive: true });
const explicitBuildId = process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim();
const head = explicitBuildId
  ? null
  : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
let buildId = explicitBuildId ?? head!;
const dirty = explicitBuildId
  ? null
  : execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const bundleDir = values["bundle-dir"]
  ? path.resolve(values["bundle-dir"])
  : path.join(artifactDir, "ui");
async function readBundleBuildId(directory: string): Promise<string> {
  const html = await readFile(path.join(directory, "index.html"), "utf8");
  const identity = html.match(
    /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
  )?.[1];
  if (!identity) {
    throw new Error("Prebuilt benchmarking requires a bundle with embedded build identity");
  }
  return normalizeControlUiBuildInfo(JSON.parse(identity)).buildId;
}
if (values["bundle-dir"] && !explicitBuildId) {
  buildId = await readBundleBuildId(bundleDir);
}
const gatewayHttpServer = values["gateway-http"]
  ? await startControlUiBenchGatewayServer(bundleDir, port)
  : undefined;
const server =
  gatewayUrl || gatewayHttpServer
    ? undefined
    : values["bundle-dir"]
      ? await startBuiltControlUiE2eServer(bundleDir, undefined, port)
      : await startProductionControlUiE2eServer(bundleDir, buildId);
const baseUrl = gatewayUrl?.origin ?? gatewayHttpServer?.baseUrl ?? server!.baseUrl;
const coldResetUrl = new URL("/__control-ui-bench-cold-reset__", baseUrl).href;
const usesGatewayHttp = Boolean(gatewayUrl || gatewayHttpServer);
const comparisonBundleDirs = values["compare-bundle-dir"].map((directory) =>
  path.resolve(directory),
);
const parkedBaselineDir = path.join(artifactDir, "baseline-bundle");
const bundleSlots = [gatewayHttpServer ? bundleDir : parkedBaselineDir, ...comparisonBundleDirs];
let activeBundle = 0;
async function selectComparisonBundle(index: number, page?: Page) {
  if (!comparisonBundleDirs.length || activeBundle === index) {
    return;
  }
  const nextBuildId = explicitBuildId ?? (await readBundleBuildId(bundleSlots[index]!));
  if (page) {
    await page.evaluate((id) => {
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway is not installed");
      }
      gateway.setServerBuildId(id);
    }, nextBuildId);
    // Retire lazy imports from the old page before its assets leave the served root.
    await page.goto("about:blank");
  }
  if (gatewayHttpServer) {
    await gatewayHttpServer.selectBuild(bundleSlots[index]!);
  } else {
    await server!.replaceBuild(bundleSlots[index]!, bundleSlots[activeBundle]!);
  }
  activeBundle = index;
  buildId = nextBuildId;
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
  baseUrl,
  sandboxUrl: buildSandboxHostPath({
    blockDescendantFrames: true,
    resourceDomains: values["dashboard-mcp-app"]
      ? [`http://127.0.0.1:${address.port}`]
      : values["dashboard-widget"]
        ? [new URL(baseUrl).origin]
        : undefined,
  }),
  sandboxPort: address.port,
  liveRun: values["live-events"] || values["streaming-reply"],
  sidebarListChurn: values["sidebar-list-churn"],
  sidebarLiveChurn: values["sidebar-live-churn"],
  sidebarAvatars: values["sidebar-avatars"],
  transcriptAvatars: values["transcript-avatars"],
  sidebarPersistentChildren: values["sidebar-persistent-children"],
  sessionEventChurn: values["session-event-churn"],
  sessionEventDurationMs,
  sessionEventAncestorRefs: values["session-event-ancestor-refs"],
  duplicateBootReads: values["duplicate-boot-reads"],
  dashboardMcpApp: values["dashboard-mcp-app"]
    ? { font: await readFile("ui/public/fonts/space-grotesk-latin.woff2") }
    : undefined,
  closedMenuMembers: values["closed-menu-members"],
  largeSnapshot: values["large-snapshot"],
  rowFacts: values["row-facts"],
  offRosterSession: values["off-roster-route"],
  transcriptMessages,
  dashboardWidgetFontUrl: dashboardFont
    ? `http://127.0.0.1:${address.port}${dashboardFontPath}`
    : undefined,
  historyStateReceipt: historyValidatorDelayMs > 0,
  dashboardPaintMarker: values["dashboard-paint-marker"],
});
const streamingReply = values["streaming-reply"]
  ? createControlUiStreamingReply(streamingRate)
  : undefined;
const extraInitScripts = await Promise.all(
  values["init-script"].map((file) => readFile(file, "utf8")),
);
const isolatedSandboxOrigin =
  values["dashboard-widget"] || values["dashboard-mcp-app"] || values["dashboard-paint-marker"]
    ? `http://127.0.0.1:${address.port}`
    : undefined;
const chromiumArgs = isolatedSandboxOrigin ? [`--isolate-origins=${isolatedSandboxOrigin}`] : [];
let sidebarLists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
let runTransfer: "full" | "delta" = sidebarRowTransfer === "delta" ? "delta" : "full";
let browser: Browser | undefined;
const results = [];
const waterfallArtifacts: Array<{
  file: string;
  capture: Awaited<ReturnType<typeof readCriticalPath>>;
  requests: CriticalPathHttpRequest[];
}> = [];
try {
  const terminalEnabled = gatewayUrl
    ? await fetch(new URL("/control-ui-config.json", gatewayUrl)).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Gateway bootstrap returned ${response.status}`);
        }
        return (await response.json()).terminalEnabled === true;
      })
    : fixture.scenario.terminalEnabled;
  const settingsCoreSchema = values["settings-core-schema"]
    ? (await import("../src/config/schema.ts")).buildConfigSchemaCore()
    : undefined;
  const prepared = await prepareControlUiMockGatewayScenario({
    ...fixture.scenario,
    subscriptionInitialHistory: true,
    ...(settingsCoreSchema
      ? {
          methodResponses: {
            ...fixture.scenario.methodResponses,
            "config.schema": settingsCoreSchema,
          },
        }
      : {}),
    terminalEnabled,
    serverBuildId: buildId,
    serverVersion: JSON.parse(await readFile("package.json", "utf8")).version,
  });
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
    args: chromiumArgs,
  });
  const context = await browser.newContext({
    viewport,
    isMobile: viewportName === "mobile",
    hasTouch: viewportName === "mobile",
    ...(colorScheme ? { colorScheme } : {}),
    serviceWorkers: "block",
    permissions: ["local-network-access"],
  });
  const page = await context.newPage();
  await page.addInitScript("globalThis.__name = (fn) => fn");
  await page.addInitScript(
    ({ bootRoute: measuredRoute }) => {
      if (window !== window.top || location.protocol === "about:") {
        return;
      }
      performance.setResourceTimingBufferSize(4096);
      const milestones = {
        firstPaintMs: null as number | null,
        firstContentfulPaintMs: null as number | null,
        firstStaticShellMs: null as number | null,
        firstLiveShellMs: null as number | null,
        firstShellInteractiveMs: null as number | null,
        firstEnabledComposerMs: null as number | null,
        firstComposerFocusMs: null as number | null,
        firstNonemptyTranscriptMs: null as number | null,
        firstRouteReadyMs: null as number | null,
        fontLoadEventsMs: [] as number[],
        staticShellGeometry: null as Record<string, unknown> | null,
        firstLiveShellGeometry: null as Record<string, unknown> | null,
        layoutShifts: [] as Array<{
          atMs: number;
          value: number;
          hadRecentInput: boolean;
          sources: Array<{
            nodeName: string | null;
            element: string | null;
            previousRect: unknown;
            currentRect: unknown;
          }>;
        }>,
        cls: 0,
        nonRecentInputShiftSum: 0,
      };
      Reflect.set(window, "__coldLoadPresentation", milestones);
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === "first-paint") {
            milestones.firstPaintMs = entry.startTime;
          } else if (entry.name === "first-contentful-paint") {
            milestones.firstContentfulPaintMs = entry.startTime;
          }
        }
      }).observe({ type: "paint", buffered: true });
      let shiftWindowStartMs = 0;
      let previousShiftMs = 0;
      let shiftWindowValue = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const value: number = Reflect.get(entry, "value");
          const hadRecentInput: boolean = Reflect.get(entry, "hadRecentInput");
          const sources: Array<{
            node?: Node;
            previousRect: DOMRectReadOnly;
            currentRect: DOMRectReadOnly;
          }> = Reflect.get(entry, "sources");
          milestones.layoutShifts.push({
            atMs: entry.startTime,
            value,
            hadRecentInput,
            sources: sources.map(({ node, previousRect, currentRect }) => {
              const element = node instanceof Element ? node : node?.parentElement;
              return {
                nodeName: node?.nodeName ?? null,
                element: element
                  ? `${element.localName}${element.id ? `#${element.id}` : ""}.${[...element.classList].join(".")}`
                  : null,
                previousRect: previousRect.toJSON(),
                currentRect: currentRect.toJSON(),
              };
            }),
          });
          if (!hadRecentInput) {
            milestones.nonRecentInputShiftSum += value;
            if (
              previousShiftMs === 0 ||
              entry.startTime - previousShiftMs >= 1000 ||
              entry.startTime - shiftWindowStartMs >= 5000
            ) {
              shiftWindowStartMs = entry.startTime;
              shiftWindowValue = 0;
            }
            previousShiftMs = entry.startTime;
            shiftWindowValue += value;
            milestones.cls = Math.max(milestones.cls, shiftWindowValue);
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
      document.fonts.addEventListener("loadingdone", () => {
        milestones.fontLoadEventsMs.push(performance.now());
      });
      document.addEventListener("focusin", (event) => {
        if (
          milestones.firstComposerFocusMs === null &&
          event.target instanceof HTMLTextAreaElement &&
          event.target.matches(
            ".agent-chat__composer-combobox textarea, .new-session-page__message",
          )
        ) {
          milestones.firstComposerFocusMs = performance.now();
        }
      });
      const visible = (element: Element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const geometry = (root: Element, selectors: Record<string, string>) =>
        Object.fromEntries(
          Object.entries({ frame: ":scope", ...selectors }).map(([name, selector]) => {
            const element = selector === ":scope" ? root : root.querySelector(selector);
            return [
              name,
              element && visible(element)
                ? {
                    ...element.getBoundingClientRect().toJSON(),
                    background: getComputedStyle(element).backgroundColor,
                  }
                : null,
            ];
          }),
        );
      const sample = () => {
        const route = location.pathname.split("/")[1] || measuredRoute;
        const readySelector =
          route === "new"
            ? ".new-session-page__message"
            : route === "sessions"
              ? ".sessions-toolbar__refresh"
              : route === "settings"
                ? "#settings-font-chat"
                : ".chat-pane-cache__pane--active .chat-virtual-row .chat-text";
        const readyControl = document.querySelector(readySelector);
        const activePane = document.querySelector(".chat-pane-cache__pane--active");
        const routeDataReady =
          route === "chat" || route === "dashboard"
            ? activePane &&
              Reflect.get(activePane, "transcriptReady") === true &&
              activePane.querySelector("textarea:not(:disabled)")
            : route === "sessions"
              ? document.querySelector("openclaw-sessions-page .session-link")
              : readyControl;
        if (
          milestones.firstRouteReadyMs === null &&
          readyControl &&
          routeDataReady &&
          visible(routeDataReady) &&
          visible(readyControl) &&
          !readyControl.matches(":disabled")
        ) {
          milestones.firstRouteReadyMs = performance.now();
        }
        const staticShell = document.querySelector("#openclaw-boot-shell");
        if (milestones.firstStaticShellMs === null && staticShell && visible(staticShell)) {
          milestones.firstStaticShellMs = performance.now();
          milestones.staticShellGeometry = geometry(staticShell, {
            sidebar: ".connect-splash__sidebar",
            transcript: ".loading-skeleton__messages",
            composer: ".loading-skeleton__composer",
          });
        }
        const shell = document.querySelector(".shell");
        const chatInput = shell?.querySelector(".agent-chat__input");
        if (
          milestones.firstLiveShellGeometry === null &&
          shell &&
          visible(shell) &&
          (chatInput ? visible(chatInput) : readyControl && visible(readyControl))
        ) {
          milestones.firstLiveShellMs = performance.now();
          milestones.firstLiveShellGeometry = geometry(shell, {
            sidebar: ".shell-nav",
            header: ".chat-pane__header, .agent-chat__header--mobile, .content-header, .topbar",
            transcript: ".chat-thread, main.content",
            composer: ".agent-chat__input, .new-session-page__message",
          });
        }
        if (
          milestones.firstShellInteractiveMs === null &&
          [...document.querySelectorAll("[data-sidebar-entry] a[href]")].some(
            (element) => element.getAttribute("aria-disabled") !== "true" && visible(element),
          )
        ) {
          milestones.firstShellInteractiveMs = performance.now();
        }
        const composer = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox textarea, .new-session-page__message",
        );
        if (
          milestones.firstEnabledComposerMs === null &&
          composer &&
          !composer.matches(":disabled") &&
          visible(composer)
        ) {
          milestones.firstEnabledComposerMs = performance.now();
        }
        if (
          milestones.firstNonemptyTranscriptMs === null &&
          [
            ...document.querySelectorAll(
              ".chat-pane-cache__pane--active .chat-virtual-row .chat-text",
            ),
          ].some((element) => element.textContent?.trim() && visible(element))
        ) {
          milestones.firstNonemptyTranscriptMs = performance.now();
        }
        if (
          milestones.firstRouteReadyMs === null ||
          milestones.firstLiveShellGeometry === null ||
          (milestones.firstShellInteractiveMs === null &&
            shell &&
            !shell.classList.contains("shell--mobile-nav"))
        ) {
          requestAnimationFrame(sample);
        }
      };
      requestAnimationFrame(sample);
    },
    { bootRoute },
  );
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
  const consoleErrors: string[] = [];
  const documentNavigations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      documentNavigations.push(frame.url());
    }
  });
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
  if (!usesGatewayHttp) {
    await installControlUiMockBootstrapDocument(
      page,
      createControlUiMockBootstrapConfig(prepared.scenario),
    );
  }
  const assets = new Map<string, { body: string | Buffer; contentType: string }>([
    ...fixture.assets,
    ...prepared.assets,
  ]);
  if (gatewayHttpServer) {
    // Native fixture HTTP keeps browser caching available for production assets.
    gatewayHttpServer.setFixtureReader((pathname) => {
      if (pathname === "/control-ui-config.json") {
        return {
          body: JSON.stringify(createControlUiMockBootstrapConfig(prepared.scenario)),
          contentType: "application/json",
        };
      }
      const asset = assets.get(pathname);
      return asset
        ? {
            ...asset,
            delayMs:
              (fixture.assets.get(pathname)?.delayMs ?? 0) +
              (values["dashboard-widget"] && pathname.startsWith("/__openclaw__/board/")
                ? latencyMs
                : 0),
          }
        : undefined;
    });
  } else {
    await page.route("**/control-ui-config.json", (route) =>
      route.fulfill({ json: createControlUiMockBootstrapConfig(prepared.scenario) }),
    );
    await page.route("**/__openclaw__/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const asset = assets.get(pathname);
      if (asset && values["dashboard-widget"] && pathname.startsWith("/__openclaw__/board/")) {
        await new Promise((resolve) => {
          setTimeout(resolve, latencyMs);
        });
      }
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
    if (
      values["sidebar-live-churn"] ||
      values["sidebar-avatars"] ||
      values["closed-menu-members"]
    ) {
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
  }
  await page.addInitScript(
    ({ key, pins, mode, bootstrap, bootstrapAttribute, fixtureUrl }) => {
      if (window !== window.top || location.protocol === "about:") {
        return;
      }
      if (fixtureUrl && location.pathname === "/chat") {
        history.replaceState(null, "", fixtureUrl);
      }
      if (bootstrap) {
        // Keep real HTTP bytes/timing while the app consumes synthetic bootstrap data.
        const apply = () => {
          if (!document.documentElement) {
            return false;
          }
          document.documentElement.setAttribute(bootstrapAttribute, bootstrap);
          return true;
        };
        if (!apply()) {
          const observer = new MutationObserver(() => {
            if (apply()) {
              observer.disconnect();
            }
          });
          observer.observe(document, { childList: true });
        }
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
      key: controlUiBundledSettingsStorageKey(baseUrl),
      fixtureUrl: usesGatewayHttp
        ? controlUiSessionUrl(baseUrl, fixture.selectedSessionKey, face)
        : null,
      bootstrap: usesGatewayHttp
        ? JSON.stringify(createControlUiMockBootstrapConfig(prepared.scenario))
        : null,
      bootstrapAttribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
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
  const paneChromeScript = values["pane-chrome-probe"]
    ? `const __paneChrome = (${installPaneChromeProbe.toString()})(); Reflect.set(window, "__paneChrome", __paneChrome);`
    : "";
  const warmProbes = values["warm-reload"]
    ? `\n${paneChromeScript}\n(${warmReloadProbe.toString()})(${JSON.stringify({ rowFacts: values["row-facts"], avatars: values["transcript-avatars"] })}, ${values["pane-chrome-probe"] ? "__paneChrome.sample" : "undefined"});`
    : "";
  const boardTickets = values["dashboard-widget"]
    ? `\n(${installRotatingBoardTickets.toString()})(${JSON.stringify(fixture.board)}, window.openclawControlUiE2eGateway);`
    : "";
  await page.addInitScript({
    content: `;(() => { if (window !== window.top || location.protocol === "about:") return; const __name = (fn) => fn; (${installWidgetReadiness.toString()})(); ${createControlUiMockGatewayInitScript(prepared.scenario)}\n${rigProbeScript}\nwindow.__teamScaleSidebarLists = { apply: (mutation) => window.__teamScaleMutate(mutation) }; window.openclawControlUiE2eGateway.setRequestHandler("sessions.list", async ({ params, respond }) => respond(await window.__teamScaleList(params))); window.openclawControlUiE2eGateway.setRequestHandler("cron.list", async ({ params, respond }) => respond(await window.__teamScaleCronList(params)));\n${boardTickets}\n${createColdLoadProbeInitScript({ latencyMs, downloadKbps: values["critical-path"] ? downloadKbps : undefined, methodLatencyMs, sidebarQueryLatencyMs, omitHelloSelfPresence: values["omit-hello-self-presence"], connectNotBeforeMs, frameGapMs, events: fixture.events, liveEvents: fixture.liveEvents, liveHistory: fixture.liveHistory, ownerProbes, sidebarCounters })}\n${streamingReply ? createStreamingReplyProbeInitScript() : ""}\n${extraInitScripts.join("\n")}\n${warmProbes} })();`,
  });
  if (values["critical-path"]) {
    await page.addInitScript({
      content: `;(() => { if (window !== window.top || location.protocol === "about:") return; const __name = (fn) => fn; (${installCriticalPathProbe.toString()})(${JSON.stringify(bootRoute)}); })();`,
    });
  }
  // Fetch the real public document; the init script selects the synthetic session.
  // Session-entry authorization is outside this static-delivery benchmark.
  const chatUrl = usesGatewayHttp
    ? new URL("/chat", baseUrl).href
    : values["full-uuid-route"]
      ? new URL(
          `/${face}/main/${fixture.selectedSessionKey.split(":").at(-1)!.replaceAll("-", "")}`,
          baseUrl,
        ).href
      : values["short-route"]
        ? new URL(controlUiSessionPath(fixture.selectedSessionKey, "", face), baseUrl).href
        : controlUiSessionUrl(baseUrl, fixture.selectedSessionKey, face);
  const url =
    bootRoute === "chat"
      ? chatUrl
      : new URL(bootRoute === "settings" ? "/settings/appearance" : `/${bootRoute}`, baseUrl).href;
  let releaseBootAssets: (() => void) | undefined;
  const heldBootAssets: Array<{ url: string; type: string }> = [];
  if (values["hold-boot-assets"]) {
    const released = new Promise<void>((resolve) => {
      releaseBootAssets = resolve;
    });
    await page.route("**/*", async (route) => {
      const type = route.request().resourceType();
      if (type === "script" || type === "stylesheet") {
        heldBootAssets.push({ url: route.request().url(), type });
        await released;
      }
      await route.fallback();
    });
  }
  async function resetColdState(cdp: CDPSession, bundleIndex: number) {
    // Retire pagehide writers before clearing the measured origin's persistent state.
    await page.goto("about:blank");
    await cdp.send("Storage.clearDataForOrigin", {
      origin: new URL(baseUrl).origin,
      storageTypes: "all",
    });
    await cdp.send("Network.clearBrowserCache");
    await selectComparisonBundle(bundleIndex);
    // The empty same-origin document seeds only the existing mock's build identity.
    await page.route(coldResetUrl, (route) =>
      route.fulfill({ body: "", contentType: "text/html" }),
    );
    await page.goto(coldResetUrl);
    await page.unroute(coldResetUrl);
    await page.evaluate((id) => {
      localStorage.clear();
      sessionStorage.clear();
      Reflect.get(window, "openclawControlUiE2eGateway").setServerBuildId(id);
    }, buildId);
  }
  async function settle(route = bootRoute) {
    try {
      const mobile = (page.viewportSize()?.width ?? viewport.width) <= 900;
      if (route !== "chat") {
        const selector =
          route === "new"
            ? ".new-session-page__message"
            : route === "sessions"
              ? ".sessions-toolbar__refresh"
              : "#settings-font-chat";
        await page.locator(selector).waitFor();
        await page.waitForFunction((readySelector) => {
          const state = Reflect.get(window, "__coldLoad")?.read();
          const control = document.querySelector(readySelector);
          const readyAt = Reflect.get(window, "__coldLoadPresentation")?.firstRouteReadyMs;
          return (
            control?.checkVisibility() &&
            !control.matches(":disabled") &&
            typeof readyAt === "number" &&
            state &&
            !state.pending &&
            !state.queued &&
            state.idleMs > 750
          );
        }, selector);
        return;
      }
      await page
        .locator(mobile ? ".agent-chat__header--mobile" : ".chat-pane__header")
        .first()
        .waitFor();
      // A closed mobile drawer parks its sidebar rows; they are not part of responsive boot.
      if (!mobile) {
        if (values["session-event-ancestor-refs"]) {
          await page
            .locator(
              `.sidebar-recent-session[data-session-key="${fixture.scenario.sessions![2]!.key}"]`,
            )
            .waitFor({ state: "visible" });
        }
        await page
          .locator(
            `[data-session-section="pinned"] [data-session-key="${fixture.pinnedKeys.at(-1)}"]`,
          )
          .waitFor({ state: "attached" });
        await page.locator('[data-sidebar-entry="plugin:team-scale-7/overview"]').waitFor();
        if (sidebarView === "online") {
          await page.locator('[data-online-user-id="team-person-120"]').waitFor();
        }
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
      const diagnostics = await page
        .evaluate(() => ({
          ...Reflect.get(window, "__coldLoad")?.read(),
          widgetReadiness: Reflect.get(window, "__readWidgetReadiness")?.(),
        }))
        .catch(() => ({ unavailable: "Page navigated while capturing diagnostics" }));
      await writeFile(
        path.join(artifactDir, "failure.json"),
        JSON.stringify({ diagnostics, errors, consoleErrors, documentNavigations }, null, 2),
      );
      await page.screenshot({ path: path.join(artifactDir, "failure.png") });
      console.error(JSON.stringify({ diagnostics, errors, consoleErrors, documentNavigations }));
      throw error;
    }
  }
  async function expandSidebar() {
    if (!values["sidebar-expanded"] && !fixture.sidebarPersistentChildren) {
      return;
    }
    if (fixture.sidebarPersistentChildren) {
      const { parentKey, childKeys } = fixture.sidebarPersistentChildren;
      const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      for (const key of childKeys) {
        await page.locator(`.sidebar-session-content [data-session-key="${key}"]`).waitFor();
      }
    }
    const expansionSaved = async (expanded: boolean) => {
      type SavedRow = { key: string; children?: SavedRow[] };
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("openclaw-chat-snapshots");
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener(
          "error",
          () => reject(request.error ?? new Error("Could not open sidebar snapshots")),
          { once: true },
        );
      });
      try {
        const records = await new Promise<
          Array<{
            model: { sections: Array<{ visibleLimit: number; rows: SavedRow[] }> };
          }>
        >((resolve, reject) => {
          const request = database
            .transaction("sidebarSnapshots")
            .objectStore("sidebarSnapshots")
            .getAll();
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(request.error ?? new Error("Could not read sidebar snapshots")),
            { once: true },
          );
        });
        const visibleKeys = [
          ...document.querySelectorAll(".sidebar-session-content .sidebar-recent-session"),
        ].map((row) => row.getAttribute("data-session-key"));
        return records.some(({ model }) => {
          const savedKeys = new Set<string>();
          const collect = (rows: SavedRow[]) => {
            for (const row of rows) {
              savedKeys.add(row.key);
              collect(row.children ?? []);
            }
          };
          collect(model.sections.flatMap((section) => section.rows));
          return (
            (!expanded || model.sections.some(({ visibleLimit }) => visibleLimit > 10)) &&
            visibleKeys.every((key) => key !== null && savedKeys.has(key))
          );
        });
      } finally {
        database.close();
      }
    };
    // Sticky live rows can exceed ten without an explicit Show more selection.
    if (values["sidebar-expanded"] && !(await page.evaluate(expansionSaved, true))) {
      await page
        .locator(".sidebar-session-content .sidebar-session-pagination__button")
        .filter({ hasText: "Show more" })
        .first()
        .click();
    }
    // waitForFunction treats an async predicate's Promise as truthy.
    const deadline = Date.now() + 30_000;
    while (!(await page.evaluate(expansionSaved, values["sidebar-expanded"]))) {
      if (Date.now() >= deadline) {
        throw new Error("Expanded sidebar membership was not persisted");
      }
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
  }
  const warmStates: Array<Awaited<ReturnType<typeof persistColdLoadWarmState>>["storage"]> = [];
  const snapshotSaves: Array<
    Omit<Awaited<ReturnType<typeof persistColdLoadWarmState>>, "storage">
  > = [];
  const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
    sessionKey: fixture.selectedSessionKey,
    rowFacts: values["row-facts"],
    offRosterSession: values["off-roster-route"],
    sidebarView: sidebarView === "online" ? "online" : "sessions",
  };
  if (!firstLoad) {
    await page.goto(chatUrl);
    try {
      if (viewportName === "mobile") {
        await navigationDrawerToggle(page).click();
        await page.locator(".shell--nav-drawer-open").waitFor();
      }
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
    await settle("chat");
    await expandSidebar();
    if (viewportName === "mobile") {
      await page.keyboard.press("Escape");
      await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
    }
    if (values["chat-dashboard-route"] || (face === "dashboard" && values["dashboard-widget"])) {
      // Save the operator's dashboard-first layout through its normal action.
      if (
        (await page
          .locator("openclaw-board-view")
          .first()
          .evaluate((board) => board.closest("[data-region]")?.getAttribute("data-region"))) !==
        "main"
      ) {
        const menu = page
          .locator(".chat-pane-cache__pane--active .chat-dashboard-menu")
          .filter({ visible: true });
        await menu.getByRole("button", { name: "Dashboard options", exact: true }).click();
        await menu
          .getByRole("menuitem", { name: /^Swap / })
          .or(menu.getByRole("menuitemcheckbox", { name: /^Swap / }))
          .click();
      }
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
          controlUiSessionUrl(baseUrl, fixture.selectedSessionKey, "chat"),
        );
      }
      await settle("chat");
    }
    await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor({ state: "attached" });
    const { storage: warmStorage, ...snapshotSave } = await page.evaluate(
      persistColdLoadWarmState,
      warmInput,
    );
    warmStates.push(warmStorage);
    snapshotSaves.push(snapshotSave);
    for (let index = 1; index < bundleSlots.length; index++) {
      await restoreColdLoadWarmState(page, warmStorage, warmStates[index - 1]);
      const reloadUrl = page.url();
      await selectComparisonBundle(index, page);
      await page.goto(reloadUrl, { waitUntil: "domcontentloaded" });
      await settle("chat");
      if (viewportName === "mobile") {
        await navigationDrawerToggle(page).click();
        await page.locator(".shell--nav-drawer-open").waitFor();
      }
      await expandSidebar();
      const { storage, ...saved } = await page.evaluate(persistColdLoadWarmState, warmInput);
      warmStates.push(storage);
      snapshotSaves.push(saved);
      if (viewportName === "mobile") {
        await page.keyboard.press("Escape");
        await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
      }
    }
    await restoreColdLoadWarmState(page, warmStorage, warmStates.at(-1));
  }
  let historyValidatorRequests = 0;
  if (historyValidatorDelayMs > 0) {
    for (const storage of warmStates) {
      const record = storage.records.snapshots.find((row) =>
        row.sessionKey.endsWith(`\u0000${fixture.selectedSessionKey}`),
      );
      if (!record || !isChatHistoryState(Reflect.get(record.snapshot, "historyState"))) {
        throw new Error("Validator-delay measurement requires a valid persisted history receipt");
      }
    }
    await page.route(/\/assets\/history-state-[^/]+\.js(?:\?.*)?$/u, async (route) => {
      historyValidatorRequests++;
      await new Promise((resolve) => {
        setTimeout(resolve, historyValidatorDelayMs);
      });
      await route.fallback();
    });
  }
  for (let run = 0; run < runs; run++) {
    const bundleIndex = run % bundleSlots.length;
    const layoutCell = layoutCells[Math.floor(run / bundleSlots.length) % layoutCells.length];
    const runRoute = layoutCell?.route ?? bootRoute;
    const runUrl =
      runRoute === "chat"
        ? values["chat-dashboard-route"]
          ? controlUiSessionUrl(baseUrl, fixture.selectedSessionKey, "chat")
          : chatUrl
        : new URL(runRoute === "settings" ? "/settings/appearance" : `/${runRoute}`, baseUrl).href;
    let reloadStorage = warmStates[bundleIndex];
    if (layoutCell) {
      await selectComparisonBundle(bundleIndex, page);
      await page.setViewportSize(
        layoutCell.viewport === "mobile"
          ? { width: 390, height: 844 }
          : { width: 1719, height: 1179 },
      );
      await page.emulateMedia({ colorScheme: layoutCell.colorScheme });
      if (!layoutCell.cold) {
        // Cold Settings never opens the chat database. Let its native owner
        // create the schema before restoring the saved warm fixture.
        await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
        await settle("chat");
        await restoreColdLoadWarmState(page, warmStates[bundleIndex]!);
        await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
        await settle("chat");
        // Save through the native owner at this viewport. Reusing the desktop
        // seed would measure a width-change restore instead of a warm reload.
        reloadStorage = (await page.evaluate(persistColdLoadWarmState, warmInput)).storage;
        if (runRoute !== "chat") {
          await page.goto(runUrl, { waitUntil: "domcontentloaded" });
          await settle(runRoute);
        }
      }
    }
    const hostLoadAverage = loadavg();
    const cpuPhases: Record<string, ColdLoadCpuTables> = {};
    async function recordCpu(phase: string, profile: Parameters<typeof mapColdLoadCpuProfile>[0]) {
      const mapped = await mapColdLoadCpuProfile(profile, {
        assetBaseUrl: new URL("assets/", baseUrl).href,
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
    const validatorRequestsBeforeReload = historyValidatorRequests;
    const cdp = await context.newCDPSession(page);
    if (layoutCell?.cold ?? firstLoad) {
      await resetColdState(cdp, bundleIndex);
    } else {
      await restoreColdLoadWarmState(page, reloadStorage!, layoutCell && reloadStorage);
      await selectComparisonBundle(bundleIndex, page);
    }
    runTransfer =
      sidebarRowTransfer === "delta" || (sidebarRowTransfer === "interleaved" && run % 2 === 1)
        ? "delta"
        : "full";
    const requests: CriticalPathHttpRequest[] = [];
    if (firstLoad || values["cold-http-cache"] || values["critical-path"]) {
      await cdp.send("Network.enable");
    }
    if (firstLoad || values["critical-path"]) {
      cdp.on("Network.requestWillBeSent", (event) => {
        requests.push({
          requestId: event.requestId,
          url: event.request.url,
          type: event.type,
          timestamp: event.timestamp,
          wallTime: event.wallTime,
          initiator: event.initiator,
        });
      });
    }
    if (values["cold-http-cache"]) {
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    }
    if (values["network-latency-ms"] !== undefined || values["download-kbps"] !== undefined) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: networkLatencyMs,
        downloadThroughput: downloadKbps > 0 ? (downloadKbps * 1000) / 8 : -1,
        uploadThroughput: -1,
      });
    }
    if (values["cpu-throttle"] !== undefined) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
    }
    const rawTrace: unknown[] = [];
    const styleSheets = new Map<string, InteractionStyleSheet>();
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
    let collectedTrace = rawTrace;
    cdp.on("Tracing.dataCollected", (data) => collectedTrace.push(...data.value));
    if (cpuProfile || values["critical-path"] || values["thread-cpu-time"]) {
      await cdp.send("Performance.enable", { timeDomain: performanceTimeDomain });
    }
    if (traced || cpuProfile) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
      await cdp.send("Profiler.start");
    }
    if (captureTrace) {
      await cdp.send("Tracing.start", {
        categories: values["filmstrip-only"]
          ? "loading,blink.user_timing,disabled-by-default-devtools.screenshot"
          : [
              "toplevel,loading,blink.user_timing,devtools.timeline",
              "disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack",
              "disabled-by-default-devtools.screenshot,v8",
              ...(values["selector-stats"]
                ? [
                    "disabled-by-default-devtools.timeline.css",
                    "disabled-by-default-blink.debug",
                    "disabled-by-default-devtools.timeline.invalidationTracking",
                  ]
                : []),
            ].join(","),
        transferMode: "ReportEvents",
      });
    }
    sidebarLists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    const criticalPathCpuBefore = values["critical-path"]
      ? await readCriticalPathCpu(cdp)
      : undefined;
    const threadCpuBefore = values["thread-cpu-time"]
      ? (await cdp.send("Performance.getMetrics")).metrics
      : undefined;
    if (values.coverage) {
      await page.coverage.startJSCoverage({ resetOnNavigation: true });
    }
    if (values["hold-boot-assets"]) {
      await page.goto(url, { waitUntil: "commit" });
      let captureTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            // A render-blocking baseline stylesheet can suppress animation frames.
            // Allow a compositor turn without making its existence the proof prerequisite.
            await page.waitForTimeout(200);
            const staticShell = await page.evaluate(() => {
              const shell = document.querySelector("#openclaw-boot-shell");
              return {
                visible:
                  shell?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false,
                geometry: shell?.getBoundingClientRect().toJSON() ?? null,
                paintEntries: performance.getEntriesByType("paint").map((entry) => entry.toJSON()),
                completedAssets: performance
                  .getEntriesByType("resource")
                  .filter((entry) =>
                    ["script", "link", "css"].includes(Reflect.get(entry, "initiatorType")),
                  )
                  .map((entry) => entry.toJSON()),
              };
            });
            // CDP captures compositor pixels without waiting for held stylesheet/font requests.
            const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
            await writeFile(
              path.join(artifactDir, "boot-assets-held.png"),
              Buffer.from(screenshot.data, "base64"),
            );
            await writeFile(
              path.join(artifactDir, "boot-assets-held.json"),
              JSON.stringify(
                {
                  ...staticShell,
                  heldAssets: heldBootAssets,
                },
                null,
                2,
              ),
            );
          })(),
          new Promise<never>((_resolve, reject) => {
            captureTimeout = setTimeout(
              () => reject(new Error("No compositor capture while boot assets were held")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(captureTimeout);
        releaseBootAssets?.();
        await page.waitForLoadState("domcontentloaded");
      }
    } else if (
      layoutCell ||
      firstLoad ||
      values["critical-path"] ||
      bootRoute !== "chat" ||
      comparisonBundleDirs.length
    ) {
      await page.goto(runUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await settle(runRoute);
    const coverage = values.coverage
      ? (await page.coverage.stopJSCoverage())
          .filter((entry) => URL.parse(entry.url)?.pathname.startsWith("/assets/"))
          .map((entry) =>
            Object.assign(
              { url: entry.url, functions: entry.functions },
              summarizeScriptCoverage(entry),
            ),
          )
      : undefined;
    if (coverage) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.coverage.json`),
        JSON.stringify(coverage, null, 2),
      );
    }
    if (historyValidatorDelayMs && historyValidatorRequests !== validatorRequestsBeforeReload + 1) {
      throw new Error("Measured reload did not request the delayed history validator exactly once");
    }
    if (captureMs) {
      await page.waitForFunction((duration) => performance.now() >= duration, captureMs);
    }
    const criticalPath = criticalPathCpuBefore
      ? [
          {
            ...(await readCriticalPath(page)),
            cpuMilliseconds: criticalPathCpuDelta(
              criticalPathCpuBefore,
              await readCriticalPathCpu(cdp),
            ),
          },
        ]
      : undefined;
    const saveCriticalPath = async () => {
      if (criticalPath) {
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.critical-path.json`),
          JSON.stringify(criticalPath, null, 2),
        );
      }
    };
    await saveCriticalPath();
    const threadCpuAfter = threadCpuBefore
      ? (await cdp.send("Performance.getMetrics")).metrics
      : undefined;
    const threadCpu =
      threadCpuBefore && threadCpuAfter
        ? Object.fromEntries(
            [
              ["scriptMs", "ScriptDuration"],
              ["taskMs", "TaskDuration"],
              ["layoutMs", "LayoutDuration"],
              ["styleMs", "RecalcStyleDuration"],
              ["threadMs", "ThreadTime"],
              ["compileMs", "V8CompileDuration"],
              ["devtoolsMs", "DevToolsCommandDuration"],
              ["otherTaskMs", "TaskOtherDuration"],
            ].map(([key, name]) => {
              const before = threadCpuBefore.find((metric) => metric.name === name)?.value;
              const after = threadCpuAfter.find((metric) => metric.name === name)?.value;
              if (before === undefined || after === undefined) {
                throw new Error(`Missing reload CPU metric: ${name}`);
              }
              return [key, (after - before) * 1_000];
            }),
          )
        : undefined;
    const metrics = await page.evaluate(() => {
      const pane = document.querySelector(".chat-pane-cache__pane--active");
      const rows = pane ? [...pane.querySelectorAll(".chat-virtual-row")] : null;
      const navigation = performance.getEntriesByType(
        "navigation",
      )[0] as PerformanceNavigationTiming;
      const waterfall = (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).map((entry) => ({
        url: entry.name,
        path: new URL(entry.name).pathname,
        initiator: entry.initiatorType,
        startMs: entry.startTime,
        requestMs: entry.requestStart,
        responseMs: entry.responseStart,
        endMs: entry.responseEnd,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
        transferBytes: entry.transferSize,
      }));
      return {
        display: {
          width: innerWidth,
          height: innerHeight,
          colorScheme: document.documentElement.dataset.themeMode,
        },
        ...Reflect.get(window, "__coldLoad").read(),
        bootRpcs: Reflect.get(window, "__coldLoad")
          .read()
          .rpcs.map((rpc: LiveRpc, index: number) => {
            const response = performance.getEntriesByName(
              `cold-load-rpc:${index}:${rpc.method}:start`,
            )[0];
            return {
              method: rpc.method,
              requestMs: response ? response.startTime - rpc.ms : null,
              responseMs: response?.startTime ?? null,
              durationMs: rpc.ms,
            };
          }),
        presentation: Reflect.get(window, "__coldLoadPresentation"),
        http: {
          navigation: {
            url: navigation.name,
            startMs: navigation.startTime,
            requestMs: navigation.requestStart,
            responseMs: navigation.responseStart,
            ttfbMs: navigation.responseStart - navigation.startTime,
            serverWaitMs: navigation.responseStart - navigation.requestStart,
            endMs: navigation.responseEnd,
            encodedBytes: navigation.encodedBodySize,
            decodedBytes: navigation.decodedBodySize,
            transferBytes: navigation.transferSize,
          },
          transferBytes:
            navigation.transferSize +
            waterfall.reduce((sum, entry) => sum + entry.transferBytes, 0),
          waterfall,
        },
        widgetReadiness: Reflect.get(window, "__readWidgetReadiness")(),
        historyValidatorResources: performance
          .getEntriesByType("resource")
          .filter((entry) => /\/assets\/history-state-[^/]+\.js(?:\?.*)?$/u.test(entry.name))
          .map((entry) => ({
            startMs: entry.startTime,
            endMs: entry.startTime + entry.duration,
          })),
        finalTranscript: {
          rows: rows?.length ?? null,
          rowKeys: rows?.map((row) => row.getAttribute("data-virtual-row-key")) ?? null,
          sessionKey: pane ? Reflect.get(pane, "sessionKey") : null,
          ready: pane ? Reflect.get(pane, "transcriptReady") === true : false,
          reactionRows: pane
            ? [...pane.querySelectorAll<HTMLElement>(".chat-message-reactions")].map((element) => ({
                messageId: element.dataset.messageId,
                visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
              }))
            : [],
        },
      };
    });
    if (firstLoad) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.requests.json`),
        JSON.stringify(requests, null, 2),
      );
    }
    if (historyValidatorDelayMs && metrics.historyValidatorResources.length !== 1) {
      throw new Error("Measured reload lacks the delayed validator resource timing");
    }
    const warmReload = values["warm-reload"]
      ? await page.evaluate(() => Reflect.get(window, "__warmReload").read())
      : undefined;
    const paneChrome = values["pane-chrome-probe"]
      ? {
          ...(await page.evaluate(
            (firstPaint) => Reflect.get(window, "__paneChrome").read(firstPaint),
            warmReload?.milestones.firstTranscriptPaint ?? null,
          )),
          snapshotBytes: Buffer.byteLength(
            JSON.stringify(
              reloadStorage!.records.snapshots.find((record) =>
                record.sessionKey.endsWith(`\u0000${fixture.selectedSessionKey}`),
              )!.snapshot,
            ),
          ),
        }
      : undefined;
    if (cpuProfile) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.cpu-clock.json`),
        JSON.stringify((await cdp.send("Performance.getMetrics")).metrics),
      );
    }
    await writeFile(
      path.join(artifactDir, `run-${run + 1}.metrics.json`),
      JSON.stringify({
        ...metrics,
        layoutCell,
        variant: ["base", "candidate", "candidate-2"][bundleIndex],
        hostLoadAverage,
        threadCpu,
        threadCpuSamples: threadCpuBefore
          ? { before: threadCpuBefore, after: threadCpuAfter }
          : undefined,
      }),
    );
    const profile = !traced && !cpuProfile ? undefined : await cdp.send("Profiler.stop");
    if (captureTrace) {
      const complete = new Promise<void>((resolve) => {
        cdp.once("Tracing.tracingComplete", () => resolve());
      });
      await cdp.send("Tracing.end");
      await complete;
    }
    if (!layoutCells.length || run < layoutCells.length * bundleSlots.length) {
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.png`) });
    }
    if (captureTrace) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.trace.json`),
        JSON.stringify({ traceEvents: rawTrace }),
      );
    }
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
    const bootTrace = traced ? summarizeColdLoadTrace(trace, metrics.at) : undefined;
    let selectorStats: { artifact: string; stylePasses: number; selectorCount: number } | undefined;
    if (values["selector-stats"] && bootTrace) {
      if (!bootTrace.navigationStartFound) {
        throw new Error("Selector statistics require a boot navigationStart boundary");
      }
      const selectors = summarizeInteractionSelectors(
        rawTrace,
        {
          startUs: bootTrace.navigationStartUs,
          endUs: bootTrace.navigationStartUs + bootTrace.durationMs * 1_000,
          rendererPid: bootTrace.rendererPid,
          rendererTid: bootTrace.rendererTid,
        },
        styleSheets,
      );
      const artifact = `run-${run + 1}.selectors.json`;
      await writeFile(path.join(artifactDir, artifact), JSON.stringify(selectors, null, 2));
      selectorStats = {
        artifact,
        stylePasses: selectors.stylePasses,
        selectorCount: selectors.selectors.length,
      };
    }
    const screenshots = trace
      .flatMap((event) =>
        event.name === "Screenshot" && event.args?.snapshot
          ? [{ ts: event.ts, data: event.args.snapshot }]
          : [],
      )
      .toSorted((a, b) => a.ts - b.ts);
    const traceNavigationStartUs = trace.find(
      (event) => event.name === "navigationStart" && event.args?.data?.isLoadingMainFrame === true,
    )?.ts;
    if (values["filmstrip-only"] && traceNavigationStartUs === undefined) {
      throw new Error("Filmstrip has no main-frame navigation timestamp");
    }
    if ((values["warm-reload"] || values["filmstrip-only"]) && screenshots.length) {
      await mkdir(path.join(artifactDir, `run-${run + 1}.filmstrip`));
      for (const [index, frame] of screenshots.entries()) {
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.filmstrip`, `${index}-${frame.ts}.jpg`),
          Buffer.from(frame.data, "base64"),
        );
      }
    }
    const visual = await page.evaluate(
      async ({ frames, navigationStartUs, marker }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 344;
        canvas.height = 236;
        const ctx = canvas.getContext("2d")!;
        let previous: DataView | undefined;
        let lastChange: number | undefined;
        let significantFrames = 0;
        let transitionGroups = 0;
        let dashboardFirstVisiblePixelsMs: number | null = null;
        const filmstrip: Array<{ ts: number; bytes: Uint8ClampedArray }> = [];
        for (const frame of frames) {
          if (navigationStartUs !== undefined && frame.ts < navigationStartUs) {
            continue;
          }
          const image = new Image();
          image.src = `data:image/jpeg;base64,${frame.data}`;
          await image.decode();
          ctx.drawImage(image, 0, 0, 344, 236);
          const bytes = ctx.getImageData(0, 0, 344, 236).data;
          const pixels = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          filmstrip.push({ ts: frame.ts, bytes });
          if (
            marker &&
            dashboardFirstVisiblePixelsMs === null &&
            navigationStartUs !== undefined &&
            frame.ts >= navigationStartUs
          ) {
            // The fixture's chart color survives JPEG/downsampling; this reads compositor pixels.
            let markerPixels = 0;
            for (let index = 0; index < bytes.length; index += 4) {
              if (
                Math.abs(bytes[index]! - 239) +
                  Math.abs(bytes[index + 1]! - 18) +
                  Math.abs(bytes[index + 2]! - 205) <
                45
              ) {
                markerPixels++;
              }
            }
            if (markerPixels >= 12) {
              dashboardFirstVisiblePixelsMs = (frame.ts - navigationStartUs) / 1000;
            }
          }
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
        // The earliest frame in the final stable suffix is a filmstrip estimate,
        // not a paint timing entry. Ignore JPEG noise and sub-0.4% pixel changes.
        const finalFrame = filmstrip.at(-1);
        let visuallyCompleteUs = finalFrame?.ts;
        if (finalFrame) {
          for (const frame of filmstrip.toReversed()) {
            let changed = 0;
            for (let index = 0; index < frame.bytes.length; index += 4) {
              if (
                Math.max(
                  Math.abs(frame.bytes[index]! - finalFrame.bytes[index]!),
                  Math.abs(frame.bytes[index + 1]! - finalFrame.bytes[index + 1]!),
                  Math.abs(frame.bytes[index + 2]! - finalFrame.bytes[index + 2]!),
                ) >= 32
              ) {
                changed++;
              }
            }
            if (changed / (344 * 236) >= 0.004) {
              break;
            }
            visuallyCompleteUs = frame.ts;
          }
        }
        return {
          frames: filmstrip.length,
          significantFrames,
          transitionGroups,
          dashboardFirstVisiblePixelsMs,
          visuallyCompleteMs:
            visuallyCompleteUs !== undefined && navigationStartUs !== undefined
              ? (visuallyCompleteUs - navigationStartUs) / 1000
              : null,
          lastSignificantChangeMs:
            lastChange !== undefined && navigationStartUs !== undefined
              ? (lastChange - navigationStartUs) / 1000
              : null,
          measurement:
            "Compositor filmstrip estimate at 344x236; final stable suffix differs from the last frame by less than 0.4% of pixels with a channel difference of at least 32. Includes skeleton animation; excludes sub-threshold changes.",
          navigationStartUs,
        };
      },
      {
        frames: screenshots,
        navigationStartUs: traceNavigationStartUs,
        marker: values["dashboard-paint-marker"],
      },
    );
    if (
      captureTrace &&
      values["dashboard-paint-marker"] &&
      face === "dashboard" &&
      visual.dashboardFirstVisiblePixelsMs === null
    ) {
      throw new Error("Filmstrip never captured the synthetic dashboard paint marker");
    }
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
              assetBaseUrl: new URL("assets/", baseUrl).href,
              assetDirectory: path.join(bundleDir, "assets"),
            });
    if (liveStartAtMs !== undefined) {
      const remainingMs = liveStartAtMs - Date.now();
      if (remainingMs < 0) {
        throw new Error("Missed paired live-start barrier");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, remainingMs);
      });
    }
    let streaming;
    if (streamingReply) {
      const composer = page.locator(".agent-chat__composer-combobox textarea").last();
      const initialDraft = await composer.inputValue();
      await composer.focus();
      await composer.evaluate((input: HTMLTextAreaElement) =>
        input.setSelectionRange(input.value.length, input.value.length),
      );
      await cdp.send("Performance.enable", { timeDomain: performanceTimeDomain });
      let previousCpu = (await cdp.send("Performance.getMetrics")).metrics;
      let previousDelivered = 0;
      const cpu: Array<{
        delivered: number;
        deltas: number;
        milliseconds: Record<string, number>;
      }> = [];
      const streamingTrace: unknown[] = [];
      collectedTrace = streamingTrace;
      if (cpuProfile) {
        await cdp.send("Profiler.start");
      }
      if (captureTrace) {
        await cdp.send("Tracing.start", {
          categories: values["filmstrip-only"]
            ? "blink.user_timing,disabled-by-default-devtools.screenshot"
            : "toplevel,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline.stack,v8,disabled-by-default-devtools.screenshot",
          transferMode: "ReportEvents",
        });
      }
      if (values["streaming-allocations"]) {
        await cdp.send("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      await page.evaluate((input) => Reflect.get(window, "__streamingReply").start(input), {
        ...streamingReply,
        burstSize: streamingBurstSize,
        observeTextVisibility: captureTrace,
        sessionKey: fixture.selectedSessionKey,
        runId: fixture.scenario.inFlightRun!.runId,
      });
      const streamingInput = new AbortController();
      let typedCharacters = 0;
      const nativeInput = (async () => {
        while (!streamingInput.signal.aborted) {
          await page.keyboard.press("x");
          typedCharacters++;
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
            { timeout: 60_000, polling: 50 },
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
      } catch (error) {
        const progress = await page.evaluate(() => Reflect.get(window, "__streamingReply").read());
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.streaming-error.json`),
          JSON.stringify({ progress, errors, consoleErrors }, null, 2),
        );
        throw error;
      } finally {
        streamingInput.abort();
        await nativeInput;
      }
      // Freeze the workload before profiler/trace shutdown adds diagnostic tasks.
      await page.evaluate(() => Reflect.get(window, "__streamingReply").stop());
      let streamingAllocations;
      const allocationProfile = values["streaming-allocations"]
        ? (await cdp.send("HeapProfiler.stopSampling")).profile
        : undefined;
      if (allocationProfile) {
        const bytes = allocationProfile.samples.reduce((sum, sample) => sum + sample.size, 0);
        streamingAllocations = {
          measurement:
            "CDP sampled allocation estimate, including major/minor-GC collected objects; whole renderer during streaming and native input, excluding reload and report serialization. Profiling adds overhead; compare timings in separate unprofiled runs.",
          samplingInterval: 4096,
          samples: allocationProfile.samples.length,
          delivered: previousDelivered,
          bytes,
          bytesPerDelta: bytes / previousDelivered,
        };
      }
      if (cpuProfile) {
        await recordCpu("streaming", (await cdp.send("Profiler.stop")).profile);
      }
      if (captureTrace) {
        const complete = new Promise<void>((resolve) => {
          cdp.once("Tracing.tracingComplete", () => resolve());
        });
        await cdp.send("Tracing.end");
        await complete;
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.streaming.trace.json`),
          JSON.stringify({ traceEvents: streamingTrace }),
        );
        const frames = streamingTrace
          .map(prepareColdLoadTraceEvent)
          .filter((event) => event.name === "Screenshot" && event.args?.snapshot);
        const directory = path.join(artifactDir, `run-${run + 1}.streaming.filmstrip`);
        await mkdir(directory);
        for (const [index, frame] of frames.entries()) {
          await writeFile(
            path.join(directory, `${index}-${frame.ts}.jpg`),
            Buffer.from(frame.args!.snapshot!, "base64"),
          );
        }
      }
      streaming = {
        ...(await page.evaluate(() => Reflect.get(window, "__streamingReply").finish())),
        cpu,
        allocations: streamingAllocations,
        typing: { characters: typedCharacters, draft: await composer.inputValue() },
      };
      if (allocationProfile) {
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.streaming.heapprofile`),
          JSON.stringify(allocationProfile),
        );
      }
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
            burstSize: streamingBurstSize,
            ...streaming,
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.streaming.png`) });
      if (
        !typedCharacters ||
        streaming.typing.draft !== initialDraft + "x".repeat(typedCharacters)
      ) {
        throw new Error(
          `Streaming lost composer input: sent ${typedCharacters} characters, retained ${streaming.typing.draft.length}`,
        );
      }
      if (
        streaming.tailPosition.scrollHeight <= streaming.tailPosition.initialScrollHeight ||
        Math.abs(streaming.tailPosition.distanceFromBottom) > 2
      ) {
        throw new Error(
          `Streaming tail did not grow and stay followed: ${JSON.stringify(streaming.tailPosition)}`,
        );
      }
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
      const before = await readLivePresentation();
      await cdp.send("Performance.enable", { timeDomain: performanceTimeDomain });
      const cpuBefore = (await cdp.send("Performance.getMetrics")).metrics;
      const liveTrace: unknown[] = [];
      collectedTrace = liveTrace;
      if (traced || cpuProfile) {
        await cdp.send("Profiler.start");
      }
      if (traced) {
        await cdp.send("Tracing.start", {
          categories:
            "toplevel,blink.user_timing,devtools.timeline,disabled-by-default-v8.cpu_profiler",
          transferMode: "ReportEvents",
        });
      }
      const listOffset = sidebarLists?.stats().length ?? 0;
      if (allocations) {
        await cdp.send("HeapProfiler.startSampling", {
          samplingInterval: GATEWAY_HEAP_SAMPLE_INTERVAL,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
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
      let allocationProfile;
      if (allocations) {
        const { profile: heapProfile } = await cdp.send("HeapProfiler.stopSampling");
        const profilePath = path.join(artifactDir, `run-${run + 1}.live.heapprofile`);
        await writeFile(profilePath, JSON.stringify(heapProfile));
        allocationProfile = readGatewayHeapProfile(profilePath);
      }
      if (traced || cpuProfile) {
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
      if (traced) {
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
        allocation: allocationProfile
          ? {
              ...allocationProfile,
              eventCount: liveMetrics.sentEvents,
              sampledAllocatedBytesPerEvent:
                allocationProfile.sampledAllocatedBytes / liveMetrics.sentEvents,
              measurement:
                "Renderer main-isolate allocation sampling including collected objects and lightweight sidebar counters; excludes other isolates and native allocations",
            }
          : undefined,
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
          sidebarReads && traced
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
      // The first non-main chat is in the initial Involving me page.
      const target = fixture.scenario.sessions![1]!;
      const link = page.locator(
        `.sidebar-recent-session[data-session-key="${target.key}"] a.sidebar-recent-session__link`,
      );
      await link.scrollIntoViewIfNeeded();
      const rpcOffset = await page.evaluate(
        () => Reflect.get(window, "__coldLoad").read().rpcs.length,
      );
      await cdp.send("Performance.enable", { timeDomain: performanceTimeDomain });
      const cpuBefore = (await cdp.send("Performance.getMetrics")).metrics;
      if (cpuProfile) {
        await cdp.send("Profiler.start");
      }
      const started = await page.evaluate(() => performance.now());
      const switchCpuBefore = criticalPath ? await readCriticalPathCpu(cdp) : undefined;
      if (values["critical-path"]) {
        await page.evaluate(
          (key) => Reflect.get(window, "__criticalPath").start("session-switch", key),
          target.key,
        );
      }
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
      if (criticalPath && switchCpuBefore) {
        criticalPath.push({
          ...(await readCriticalPath(page)),
          cpuMilliseconds: criticalPathCpuDelta(switchCpuBefore, await readCriticalPathCpu(cdp)),
        });
        await saveCriticalPath();
      }
    }
    if (criticalPath) {
      for (const route of navigationRoutes) {
        // Each route starts from its own settled boot owners, not a previous page's reads.
        sidebarLists = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
        if (firstLoad) {
          await resetColdState(cdp, bundleIndex);
        }
        const routeRequestsOffset = requests.length;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await settle();
        const routeTrace: unknown[] = [];
        const routeCapture = await navigateCriticalPath(
          page,
          cdp,
          route,
          cpuProfile
            ? async () => {
                collectedTrace = routeTrace;
                await cdp.send("Profiler.start");
                await cdp.send("Tracing.start", {
                  categories:
                    "toplevel,loading,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8",
                  transferMode: "ReportEvents",
                });
              }
            : undefined,
          criticalPathIntentMs,
        );
        if (cpuProfile) {
          const routeProfile = (await cdp.send("Profiler.stop")).profile;
          const complete = new Promise<void>((resolve) => {
            cdp.once("Tracing.tracingComplete", () => resolve());
          });
          await cdp.send("Tracing.end");
          await complete;
          await recordCpu(route, routeProfile);
          await writeFile(
            path.join(artifactDir, `run-${run + 1}.${route}.trace.json`),
            JSON.stringify({ traceEvents: routeTrace }),
          );
        }
        // Observe late shifts after timing/CPU capture without extending those measured intervals.
        await page.waitForTimeout(500);
        const presentationSnapshot: Pick<
          CriticalPathPresentation,
          "startedMs" | "capturedMs" | "layoutShifts"
        > = await page.evaluate((startedMs) => {
          const capturedMs = performance.now();
          return {
            startedMs,
            capturedMs,
            layoutShifts: Reflect.get(window, "__coldLoadPresentation").layoutShifts.filter(
              (shift: { atMs: number }) => shift.atMs >= startedMs && shift.atMs <= capturedMs,
            ),
          };
        }, routeCapture.intentStartedMs ?? routeCapture.startedMs);
        let cls = 0;
        let nonRecentInputShiftSum = 0;
        let allShiftSum = 0;
        let shiftWindowStartMs = 0;
        let previousShiftMs = 0;
        let shiftWindowValue = 0;
        for (const shift of presentationSnapshot.layoutShifts) {
          allShiftSum += shift.value;
          if (shift.hadRecentInput) {
            continue;
          }
          nonRecentInputShiftSum += shift.value;
          if (
            previousShiftMs === 0 ||
            shift.atMs - previousShiftMs >= 1000 ||
            shift.atMs - shiftWindowStartMs >= 5000
          ) {
            shiftWindowStartMs = shift.atMs;
            shiftWindowValue = 0;
          }
          previousShiftMs = shift.atMs;
          shiftWindowValue += shift.value;
          cls = Math.max(cls, shiftWindowValue);
        }
        criticalPath.push({
          ...routeCapture,
          presentation: {
            ...presentationSnapshot,
            settleMs: 500,
            cls,
            nonRecentInputShiftSum,
            allShiftSum,
          },
        });
        const routeRequests = requests.slice(routeRequestsOffset);
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.${route}.requests.json`),
          JSON.stringify(
            {
              timeOrigin: routeCapture.timeOrigin,
              startedMs: routeCapture.startedMs,
              readyMs: routeCapture.readyMs,
              capturedMs: routeCapture.capturedMs,
              requests: routeRequests,
            },
            null,
            2,
          ),
        );
        waterfallArtifacts.push({
          file: path.join(artifactDir, `run-${run + 1}.${route}.waterfall.html`),
          capture: routeCapture,
          requests: routeRequests,
        });
        await saveCriticalPath();
        await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.${route}.png`) });
      }
    }
    await cdp.detach();
    const result = {
      layoutCell,
      run: run + 1,
      hostLoadAverage,
      ...(comparisonBundleDirs.length
        ? {
            variant: ["base", "candidate", "candidate-2"][bundleIndex],
            bundleSource: [bundleDir, ...comparisonBundleDirs][bundleIndex],
          }
        : {}),
      head,
      buildId,
      sidebarRowTransfer: values["sidebar-list-churn"] ? runTransfer : undefined,
      ...metrics,
      threadCpu,
      coverage,
      javaScriptResources: summarizeJavaScriptResources(metrics.http.waterfall, coverage),
      trace: bootTrace,
      selectorStats,
      longTaskDetails:
        bootTrace && mapped && profile
          ? summarizeLongTaskCpuProfiles(
              {
                ...mapped.profile,
                startTime: profile.profile.startTime,
                endTime: profile.profile.endTime,
              },
              bootTrace.longTaskIntervals,
            )
          : undefined,
      cpu: mapped ? summarizeCpuProfile(mapped.profile) : undefined,
      mappedFrames: mapped?.mappedFrames,
      unmappedFrames: mapped?.unmappedFrames,
      harnessWarnings,
      visual,
      live,
      streaming,
      sessionSwitch,
      criticalPath,
      warmReload,
      paneChrome,
      historyValidatorRequests: historyValidatorRequests - validatorRequestsBeforeReload,
      snapshotSave: snapshotSaves[bundleIndex],
      overlays,
    };
    results.push(result);
    // The preview server shares this process; keep full result serialization
    // after the measured runs, in summary.json.
    console.log(
      JSON.stringify({
        run: result.run,
        layoutCell,
        variant: result.variant,
        hostLoadAverage,
        presentation: {
          firstContentfulPaintMs: result.presentation.firstContentfulPaintMs,
          firstStaticShellMs: result.presentation.firstStaticShellMs,
          firstShellInteractiveMs: result.presentation.firstShellInteractiveMs,
          firstEnabledComposerMs: result.presentation.firstEnabledComposerMs,
          firstNonemptyTranscriptMs: result.presentation.firstNonemptyTranscriptMs,
          cls: result.presentation.cls,
        },
      }),
    );
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
  await server?.close();
  await gatewayHttpServer?.close();
  sandbox.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    sandbox.close((error) => (error ? reject(error) : resolve()));
  });
  for (const artifact of waterfallArtifacts) {
    await writeFile(
      artifact.file,
      renderCriticalPathWaterfall(artifact.capture, artifact.requests),
    );
  }
  await writeFile(
    path.join(artifactDir, "summary.json"),
    JSON.stringify(
      {
        head,
        buildId,
        dirty,
        bundleDir,
        gatewayUrl: gatewayUrl?.origin,
        httpBoundary: gatewayUrl
          ? "Real Gateway HTTP documents/assets; synthetic bootstrap, WebSocket RPC and fixture media. Server cache lifecycle is controlled externally."
          : gatewayHttpServer
            ? "Production Gateway HTTP handler; synthetic bootstrap, WebSocket RPC and fixture media. Immutable server asset caches stay warm per bundle."
            : "Vite production preview HTTP; synthetic bootstrap, WebSocket RPC and fixture media.",
        firstLoad,
        gatewayHttp: values["gateway-http"],
        bootRoute,
        coldHttpCache: values["cold-http-cache"],
        coverage: values.coverage,
        networkLatencyMs,
        downloadKbps,
        cpuThrottle,
        comparisonBundleDirs,
        fixture: fixture.counts,
        sidebarView,
        sidebarAvatars: values["sidebar-avatars"],
        sidebarExpanded: values["sidebar-expanded"],
        sidebarPersistentChildren: fixture.sidebarPersistentChildren,
        omitHelloSelfPresence: values["omit-hello-self-presence"],
        streamingReply: values["streaming-reply"],
        streamingAllocations: values["streaming-allocations"],
        sessionSwitch: values["session-switch"],
        criticalPathRoutes: values["critical-path"] ? navigationRoutes : undefined,
        criticalPathIntentMs: values["critical-path"] ? criticalPathIntentMs : undefined,
        settingsCoreSchema: values["settings-core-schema"],
        sidebarListChurn: values["sidebar-list-churn"],
        sidebarLiveChurn: fixture.sidebarLiveChurn,
        duplicateBootReads: values["duplicate-boot-reads"],
        dashboardMcpApp: values["dashboard-mcp-app"],
        chatDashboardRoute: values["chat-dashboard-route"],
        traced,
        selectorStats: values["selector-stats"],
        filmstripOnly: values["filmstrip-only"],
        holdBootAssets: values["hold-boot-assets"],
        historyValidatorDelayMs,
        dashboardPaintMarker: values["dashboard-paint-marker"],
        colorScheme,
        viewport: { name: viewportName, ...viewport },
        chromiumArgs,
        isolatedSandboxOrigin,
        cpuProfile,
        ownerProbes,
        sidebarCounters,
        metricTimeDomain: performanceTimeDomain,
        cpuProfileCompare: values["cpu-profile-compare"],
        sidebarRowTransfer,
        sidebarComparison: values["sidebar-list-churn"]
          ? "Same final client bundle; full/delta wire response A/B using the production presenter and one synthetic query/history owner. This does not measure real Gateway selection, history reset/fallback lifecycle, or server projection CPU. Node IPC is outside the measured application response task."
          : undefined,
        latencyProfile,
        latencyMs,
        methodLatencyMs,
        sidebarQueryLatencyMs,
        connectNotBeforeMs,
        dashboardWidget: values["dashboard-widget"],
        rowFacts: values["row-facts"],
        face,
        shortRoute: values["short-route"],
        fullUuidRoute: values["full-uuid-route"],
        offRosterRoute: values["off-roster-route"],
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
