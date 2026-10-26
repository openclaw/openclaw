// Production Talk renderer with native synthetic audio and the existing E2E provider contract.
// CPU comparisons: --pairs 10 (or 20) --aa. Diagnostic passes: --trace/--counters/--frames.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { BrowserContext, CDPSession, ElementHandle, Page, Request } from "playwright";
import {
  TALK_READY_HISTORY_MESSAGE,
  waitForTalkReady,
} from "../ui/src/e2e/browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import {
  mapColdLoadCpuProfile,
  prepareColdLoadTraceEvent,
  summarizeCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import { clipInteractionCpuProfile } from "./lib/control-ui-interaction-trace.ts";
import {
  installTalkPerfFixture,
  launchTalkObservationBrowser,
  saveTalkFailure,
  type TalkBenchState,
} from "./lib/control-ui-talk-fixture.ts";
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    url: { type: "string" },
    "compare-url": { type: "string" },
    "compare-css-file": { type: "string" },
    "compare-script-file": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-talk" },
    pairs: { type: "string", default: "10" },
    "duration-ms": { type: "string", default: "5000" },
    viewport: { type: "string", default: "both" },
    "cpu-throttle": { type: "string", default: "1,4" },
    states: { type: "string", default: "listening,speaking,responding,transcribing,idle,hidden" },
    "external-transcripts": { type: "boolean", default: false },
    "expect-hidden-parked": { type: "boolean", default: false },
    "focused-stop": { type: "boolean", default: false },
    "startup-latency": { type: "boolean", default: false },
    "startup-warm-cache": { type: "boolean", default: false },
    aa: { type: "boolean", default: false },
    sample: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    counters: { type: "boolean", default: false },
    frames: { type: "boolean", default: false },
    "process-wakeups": { type: "boolean", default: false },
    "compare-suspend-native-audio": { type: "boolean", default: false },
    "first-pair-screenshots": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});
const pairs = values.sample ? 1 : Number(values.pairs);
const durationMs = values.sample ? 1000 : Number(values["duration-ms"]);
const cpuRates = values["cpu-throttle"].split(",").map(Number);
const states = values.states.split(",") as TalkBenchState[];
const transcriptPeriodMs = 50;
const compareCss = values["compare-css-file"]
  ? await readFile(values["compare-css-file"], "utf8")
  : undefined;
const compareScript = values["compare-script-file"]
  ? await readFile(values["compare-script-file"], "utf8")
  : undefined;
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(durationMs) ||
  durationMs < 1000 ||
  cpuRates.some((rate) => !Number.isFinite(rate) || rate < 1) ||
  states.some(
    (state) =>
      ![
        "listening",
        "speaking",
        "responding",
        "transcribing",
        "idle",
        "hidden",
        "hidden-transcribing",
      ].includes(state),
  ) ||
  !["desktop", "mobile", "both"].includes(values.viewport)
) {
  throw new Error("Invalid benchmark selection");
}
if (
  values.frames &&
  states.some((state) => state === "hidden" || state === "hidden-transcribing" || state === "idle")
) {
  throw new Error(
    "--frames adds animation wakeups: select active states only for a separate diagnostic pass",
  );
}
if (values["expect-hidden-parked"] && !states.includes("hidden-transcribing")) {
  throw new Error("--expect-hidden-parked requires hidden-transcribing");
}
if (
  values["compare-suspend-native-audio"] &&
  states.some((state) => !["listening", "idle", "hidden"].includes(state))
) {
  throw new Error(
    "--compare-suspend-native-audio is a diagnostic limited to listening,idle,hidden",
  );
}
if (
  values["focused-stop"] &&
  (values["external-transcripts"] ||
    values.frames ||
    states.some((state) => state !== "listening" && state !== "idle"))
) {
  throw new Error(
    "--focused-stop requires listening/idle states without --external-transcripts or --frames",
  );
}
if (values["startup-warm-cache"] && !values["startup-latency"]) {
  throw new Error("--startup-warm-cache requires --startup-latency");
}
const startupMode = values["startup-warm-cache"]
  ? "warm-cache-settled-start"
  : "cold-precache-start";
const artifactDir = createControlUiE2eArtifactDir("talk", values.output);
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
].filter((viewport) => values.viewport === "both" || viewport.name === values.viewport);
const slots: Array<{
  url: string;
  buildId: string;
  version: string;
  indexSha256: string;
  assetHashes: Record<string, string>;
  directory?: string;
  close?: () => Promise<void>;
}> = [];
type ProcessInfo = {
  id: number;
  type: string;
  cpuTime: number;
};
type TalkLayer = {
  layerId: string;
  backendNodeId?: number;
};
type WakeupRow = {
  pid: number;
  startAbstime?: string;
  exitAbstime?: string;
  interruptWakeups?: string;
  packageIdleWakeups?: string;
  error?: string;
};
type Wakeups = {
  processes: WakeupRow[];
};
function trackBrowserNetwork(context: BrowserContext, assetBase: string) {
  const pending = new Set<Request>();
  let assetGets = 0;
  let serviceWorkerAssetGets = 0;
  let lastActivity = performance.now();
  let checkQuiet: (() => void) | undefined;
  const isAssetGet = (request: Request) =>
    request.method() === "GET" && request.url().startsWith(assetBase);
  context.on("request", (request) => {
    pending.add(request);
    if (isAssetGet(request)) {
      assetGets++;
      if (request.serviceWorker()) {
        serviceWorkerAssetGets++;
      }
    }
    lastActivity = performance.now();
    checkQuiet?.();
  });
  const finished = (request: Request) => {
    pending.delete(request);
    lastActivity = performance.now();
    checkQuiet?.();
  };
  context.on("requestfinished", finished);
  context.on("requestfailed", finished);
  return {
    snapshot: () => ({
      assetGets,
      serviceWorkerAssetGets,
      pendingAssetGets: [...pending].filter(isAssetGet).length,
    }),
    waitForQuiet: () =>
      new Promise<void>((resolve, reject) => {
        let quietTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error) => {
          clearTimeout(quietTimer);
          clearTimeout(deadline);
          checkQuiet = undefined;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const deadline = setTimeout(
          () => finish(new Error("Browser network did not become quiet within 70 seconds")),
          70_000,
        );
        checkQuiet = () => {
          clearTimeout(quietTimer);
          if (!pending.size) {
            const remaining = 1500 - (performance.now() - lastActivity);
            if (remaining <= 0) {
              finish();
            } else {
              quietTimer = setTimeout(() => checkQuiet?.(), remaining);
            }
          }
        };
        checkQuiet();
      }),
  };
}
async function metrics(cdp: CDPSession) {
  const {
    metrics: list,
  }: {
    metrics: Array<{
      name: string;
      value: number;
    }>;
  } = await cdp.send("Performance.getMetrics");
  const result = Object.fromEntries(list.map(({ name, value }) => [name, value]));
  for (const name of [
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "JSHeapUsedSize",
    "Timestamp",
  ]) {
    if (!Number.isFinite(result[name])) {
      throw new Error(`Missing Chromium metric: ${name}`);
    }
  }
  return result;
}
async function processes(cdp: CDPSession): Promise<ProcessInfo[]> {
  return (await cdp.send("SystemInfo.getProcessInfo")).processInfo;
}
function processCpuDelta(before: ProcessInfo[], after: ProcessInfo[]) {
  const byTypeMs: Record<string, number> = {};
  const matched = [];
  const unmatchedBefore = [];
  for (const initial of before) {
    const final = after.find(({ id, type }) => id === initial.id && type === initial.type);
    if (!final) {
      if (initial.type === "renderer") {
        throw new Error("Renderer process disappeared during sample");
      }
      unmatchedBefore.push({ id: initial.id, type: initial.type });
      continue;
    }
    const cpuMs = (final.cpuTime - initial.cpuTime) * 1000;
    byTypeMs[initial.type] = (byTypeMs[initial.type] ?? 0) + cpuMs;
    matched.push({ id: initial.id, type: initial.type, cpuMs });
  }
  const unmatchedAfter = after
    .filter((final) => !before.some(({ id, type }) => id === final.id && type === final.type))
    .map(({ id, type }) => ({ id, type }));
  return {
    byTypeMs,
    matched,
    unmatchedBefore,
    unmatchedAfter,
    complete: unmatchedBefore.length === 0 && unmatchedAfter.length === 0,
  };
}
let wakeupReader: string | undefined;
if (values["process-wakeups"]) {
  if (process.platform !== "darwin") {
    throw new Error("--process-wakeups requires Darwin proc_pid_rusage");
  }
  wakeupReader = path.join(artifactDir, "darwin-process-wakeups");
  execFileSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-O2",
      "-Wall",
      "-Wextra",
      "-std=c11",
      fileURLToPath(new URL("./perf/darwin-process-wakeups.c", import.meta.url)),
      "-o",
      wakeupReader,
    ],
    { stdio: "pipe" },
  );
}
function wakeups(rows: ProcessInfo[]): Wakeups | undefined {
  return wakeupReader
    ? JSON.parse(
        execFileSync(
          wakeupReader,
          rows.map(({ id }) => String(id)),
          { encoding: "utf8" },
        ),
      )
    : undefined;
}
function wakeupDelta(before: Wakeups | undefined, after: Wakeups | undefined) {
  if (!before || !after) {
    return undefined;
  }
  let interrupts = 0n;
  let packageIdle = 0n;
  if (before.processes.length !== after.processes.length) {
    throw new Error("Wakeup process set changed");
  }
  for (const initial of before.processes) {
    const final = after.processes.find(({ pid }) => pid === initial.pid);
    if (
      !final ||
      initial.error ||
      final.error ||
      !initial.startAbstime ||
      initial.startAbstime === "0" ||
      final.startAbstime !== initial.startAbstime ||
      initial.exitAbstime !== "0" ||
      final.exitAbstime !== "0"
    ) {
      throw new Error("Wakeup process identity changed or counters unavailable");
    }
    const interruptDelta = BigInt(final.interruptWakeups!) - BigInt(initial.interruptWakeups!);
    const idleDelta = BigInt(final.packageIdleWakeups!) - BigInt(initial.packageIdleWakeups!);
    if (interruptDelta < 0n || idleDelta < 0n) {
      throw new Error("Wakeup counters moved backwards");
    }
    interrupts += interruptDelta;
    packageIdle += idleDelta;
  }
  return { interruptWakeups: Number(interrupts), packageIdleWakeups: Number(packageIdle) };
}
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted.length
    ? {
        n: sorted.length,
        median:
          sorted.length % 2
            ? sorted[Math.floor(sorted.length / 2)]
            : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2,
        p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        min: sorted[0],
        max: sorted.at(-1),
      }
    : undefined;
}
type Sample = {
  comparison: string;
  side: number;
  pair: number;
  viewport: string;
  cpuRate: number;
  state: TalkBenchState;
  status: string;
  prefix: string;
  [key: string]: unknown;
};
type NativePlayAttempt = {
  callIndex: number;
  sourceKind: "srcObject" | "src" | "empty";
  srcKind: "data-audio-wav" | "data" | "blob" | "url" | "empty";
  srcObjectKind: "MediaStream" | "other" | null;
  connectedAtInvoke: boolean;
  invokedAtMs: number;
  resolvedAtMs: number | null;
  rejectedAtMs: number | null;
  rejectionName: string | null;
};
function summarizeNativePlays(probe: Window["talkStartupProbe"]) {
  const origin = probe.gestureAtMs;
  const relative = (at: number | null) => (at === null || origin === null ? null : at - origin);
  return probe.playCalls.map((call) => ({
    callIndex: call.callIndex,
    sourceKind: call.sourceKind,
    srcKind: call.srcKind,
    srcObjectKind: call.srcObjectKind,
    connectedAtInvoke: call.connectedAtInvoke,
    invokedAfterGestureMs: relative(call.invokedAtMs),
    resolvedAfterGestureMs: relative(call.resolvedAtMs),
    rejectedAfterGestureMs: relative(call.rejectedAtMs),
    playDurationMs: call.resolvedAtMs === null ? null : call.resolvedAtMs - call.invokedAtMs,
    rejectionName: call.rejectionName,
  }));
}
type StartupLatency = {
  gestureToReadyMs: number;
  gestureToPlayMs: number;
  playToReadyMs: number;
  taskMs: number;
  scriptMs: number;
  styleMs: number;
  mode: typeof startupMode;
  legacyFirstPlayUnlock: {
    callIndex: number;
    sourceKind: NativePlayAttempt["sourceKind"];
    srcKind: NativePlayAttempt["srcKind"];
    gestureToReadyMs: number;
    gestureToPlayMs: number;
    playToReadyMs: number;
  };
  remoteStream: {
    callIndex: number;
    gestureToPlayMs: number;
    gestureToReadyMs: number;
    playToReadyMs: number;
  };
  readinessWait: {
    afterGestureMs: number;
    afterRemotePlayResolutionMs: number;
  };
  nativePlayCalls: ReturnType<typeof summarizeNativePlays>;
  hostLoadAverage: number[];
  network: {
    assetGets: number;
    serviceWorkerAssetGets: number;
    pendingAssetGetCountAtStart: number;
    pendingAssetGetCountAtEnd: number;
  };
};
declare global {
  interface Window {
    talkStartupProbe: {
      gestureAtMs: number | null;
      firstPlayAtMs: number | null;
      readyAtMs: number | null;
      readinessObservedAtMs: number | null;
      playCalls: NativePlayAttempt[];
    };
  }
}
const results: Sample[] = [];
const startupPlayback: Array<{
  comparison: string;
  side: number;
  pair: number;
  viewport: string;
  cpuRate: number;
  playLatenciesMs: number[];
  startup?: StartupLatency;
}> = [];
try {
  const sources = values.url
    ? [values.url, values["compare-url"]]
    : [values["bundle-dir"], values["compare-bundle-dir"]];
  for (const source of sources.filter((entry): entry is string => Boolean(entry))) {
    let url: string;
    let html: string;
    let close: (() => Promise<void>) | undefined;
    if (values.url) {
      url = source;
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
        throw new Error("Only isolated localhost URLs are accepted");
      }
      html = await (await fetch(url)).text();
    } else {
      html = await readFile(path.join(source, "index.html"), "utf8");
      const server = await startControlUiBenchGatewayServer(source);
      url = server.baseUrl;
      close = () => server.close();
    }
    const identity = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!identity) {
      await close?.();
      throw new Error(`Missing production build identity: ${source}`);
    }
    const build: {
      buildId: string;
      version: string;
    } = JSON.parse(identity);
    slots.push({
      directory: values.url ? undefined : path.resolve(source),
      url,
      ...build,
      indexSha256: createHash("sha256").update(html).digest("hex"),
      assetHashes: {},
      close,
    });
  }
  if (!slots.length) {
    throw new Error("No bundle selected");
  }
  if (values["compare-suspend-native-audio"] && slots.length !== 2) {
    throw new Error("--compare-suspend-native-audio requires two bundle slots");
  }
  const manifest = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceHashes: {
      runner: createHash("sha256")
        .update(await readFile(new URL(import.meta.url)))
        .digest("hex"),
      fixture: createHash("sha256")
        .update(await readFile(new URL("./lib/control-ui-talk-fixture.ts", import.meta.url)))
        .digest("hex"),
    },
    slots: slots.map(({ url, buildId, version, indexSha256, directory, assetHashes }) => ({
      url,
      buildId,
      version,
      indexSha256,
      directory,
      assetHashes,
    })),
    pairs,
    durationMs,
    viewports,
    cpuRates,
    states,
    externalTranscripts: values["external-transcripts"],
    transcriptPeriodMs,
    expectHiddenParked: values["expect-hidden-parked"],
    focusedStop: values["focused-stop"],
    startupLatency: values["startup-latency"],
    startupMode,
    precachePhase: values["startup-warm-cache"] ? "before-start" : "after-start",
    startupProbeContract:
      "Optional browser-local pointerdown records every native play invocation, resolution and rejection, source kind only (no URLs). Legacy top-level timings and legacyFirstPlayUnlock still identify first play, the production gesture-unlock WAV; remoteStream identifies the first MediaStream play separately. readinessWait ends when the existing Stop/audio/all-playback readiness polling succeeds. CPU spans Start click through readiness assertion and protocol work, not just native play. Wrapper returns the exact fixture play promise; no production hooks. Cold-precache-start preserves the old ordering. --startup-warm-cache instead verifies the same worker precache and network quiet before Start; it is a separate warm-cache-settled-start population, not a correction to cold results. Lazy-module requests can still occur at Start and are reported. Existing strict state-window traffic checks remain unchanged. Synthetic transport and muted native audio; no acoustic, provider, or network latency claim.",
    headless: !values.headed,
    workloadVersion: "precache-settled-v4-native-play-attribution",
    networkContract:
      "Production service workers remain enabled. Before measurement, wait for activation, issue the existing version/precache probe, await the worker's existing preparation promises through its inspector, and verify every boot/deferred inventory URL in its current cache. No worker code or production API is changed. Then wait for 1.5 seconds of browser-context network quiet (70 seconds maximum), including worker and failed/aborted requests. Quiet-window timers end before measurement. Asset GET counters conservatively bracket both Performance.getMetrics endpoint calls. In-flight or new asset GETs invalidate the sample and fail the run; failed samples remain in artifacts.",
    assetHashContract:
      "Hashes of server files (or Node-fetched assets) matched to observed browser resource URLs; not browser-response byte attestation.",
    mode:
      values["compare-suspend-native-audio"] || values.trace || values.counters || values.frames
        ? "diagnostic"
        : "thread-cpu-comparison",
    diagnosticKind: values["compare-suspend-native-audio"]
      ? "native-audio-counterfactual"
      : undefined,
    instrumentation: {
      trace: values.trace,
      counters: values.counters,
      frameProbe: values.frames,
      processWakeups: values["process-wakeups"],
      observerCallbacks: values.counters,
      compareSuspendNativeAudio: values["compare-suspend-native-audio"],
      compositorLayers: values.trace,
    },
    compositorLayerContract:
      "--trace retains the latest LayerTree.layerTreeDidChange event. Before fixture counters and the CPU window start, layers.json records each reported layer's compositing reasons and backend-node matches for all seven meter spans. Layers retired during metadata collection are marked stale. This is a pre-sample snapshot. LayerTree instrumentation is diagnostic overhead; DOM/reason queries and artifact writes run outside the measured interval.",
    nativeAudioContract:
      "--compare-suspend-native-audio is a counterfactual diagnostic, never a product win or audio/latency proof. Supply the same frozen bundle in both slots to isolate native audio cost: AB side 1 suspends audio; AB side 0 and both A/A sides retain normal audio. Alternating side order and --aa provide interleaved shared-host controls. Only the suspended side wraps the native AudioContext constructor; after state/visibility setup it awaits suspension of every tracked live context and pauses every native audio element, without disconnecting the media graph, stopping tracks, or changing the meter JS timer. Every row records whether suspension is enabled; suspended rows record context states/counts and paused playback before suspension and at both sample endpoints. Native Stop still owns cleanup; each next state suspends again after any visibility-driven resume.",
    processCpuContract:
      "processCpu.byTypeMs sums CPU deltas only for matching endpoint process IDs and types. matched retains per-process deltas; unmatchedBefore/unmatchedAfter identify transient processes, so incomplete samples cannot claim total browser CPU. rendererCpuMs includes all matched renderer threads, not just main-thread work; TaskDuration/ScriptDuration use the main-thread threadTicks domain.",
    observationContract:
      "Every non-focused sample verifies neutral tooltips. Ordinary CPU samples do not install the transcript observer; transcribing samples observe transcript DOM unless external delivery is selected without counters. Counters mode wraps native MutationObserver, ResizeObserver, and IntersectionObserver callbacks, including fixture-owned observers. Neutral ordinary samples differ from earlier runs that could retain Stop hover.",
    revealClockContract:
      "reveal.browser uses the page performance clock: visibilitychange event timestamp to complete transcript DOM and two native animation frames. Existing reveal wall times use the Node clock and include browser restoration, protocol, and polling delays. The reveal-only native MutationObserver disconnects after DOM catchup; frame readiness is an opportunity to render, not proof of physical display presentation.",
    compareCss,
    compareScript,
    contract:
      "Production renderer; native oscillator microphone and native audio-element playback; synthetic WebRTC/provider events. No real-provider, network, hardware microphone, end-to-end audio latency, or battery-life claim. Playback latency measures the local native play() promise, not network round-trip. Transcript latency is provider-event dispatch to DOM observation, not INP. Idle means a connected Talk session without audio/transcript work; hidden means a connected listening session in an actually hidden document. Hidden-transcribing delivers provider chunks from Node at 20Hz and verifies complete catchup and retained row identity after reveal. External transcript CPU windows omit per-chunk DOM observation unless --counters is enabled; endpoint scans run after metrics. Speaking means user microphone input with 0.8Hz amplitude modulation, silenced at the audio element. Responding means silent microphone input with native playback still active and a synthetic response.created holding the TTS thinking animation; a matching completed response.done with empty output settles it after observation or before the next state. Frame probe adds its own RAF loop, so run separately. Focused-stop uses native Tab traversal and requires the Stop trigger, its own tooltip, and document focus to remain active throughout the interval. All timers/animations retain native clocks.",
    acceptance: values["compare-suspend-native-audio"]
      ? "Diagnostic attribution only: use interleaved same-bundle AB pairs and normal-audio A/A controls. Suspended audio invalidates product performance and latency acceptance, regardless of measured CPU reduction."
      : "At least 10 interleaved pairs; aim for 40% active CPU reduction and near-zero idle/hidden renderer work. A clean >=5% CPU win may land; per-cell timing median regression <=5% with no p95 increase (or 20-pair confirmation). A/A identifies shared-host wall-time noise; never claim network/provider latency from this fixture.",
  };
  await writeFile(path.join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const comparisons = [...(slots.length === 2 ? ["AB"] : ["A"]), ...(values.aa ? ["AA"] : [])];
  for (const viewport of viewports) {
    for (const cpuRate of cpuRates) {
      for (let pair = 0; pair < pairs; pair++) {
        for (const comparison of comparisons) {
          // Reverse alternate pairs to remove consistently first/second browser bias.
          const sides = comparison === "A" ? [0] : pair % 2 ? [1, 0] : [0, 1];
          for (const side of sides) {
            const slot = slots[comparison === "AA" ? 0 : side]!;
            const suspendNativeAudio =
              values["compare-suspend-native-audio"] && comparison === "AB" && side === 1;
            const browserPrefix = `${comparison}-${viewport.name}-${cpuRate}x-${pair}-${side}`;
            const observation = await launchTalkObservationBrowser(artifactDir, values.headed);
            let browserCdp: CDPSession | undefined;
            let cdp: CDPSession | undefined;
            let tracing = false;
            let layerTreeEnabled = false;
            let startupPage: Page | undefined;
            let latestLayers: TalkLayer[] | undefined;
            const collectLayers = ({ layers }: { layers?: TalkLayer[] }) => {
              latestLayers = layers ?? [];
            };
            const events: unknown[] = [];
            const collectTrace = ({ value }: { value: unknown[] }) => {
              events.push(...value);
            };
            try {
              const assetBase = new URL("assets/", slot.url).href;
              const network = trackBrowserNetwork(observation.context, assetBase);
              const page = await observation.context.newPage();
              startupPage = page;
              page.setDefaultTimeout(20000 * cpuRate);
              await page.setViewportSize(viewport);
              await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
              const errors: string[] = [];
              page.on("pageerror", (error) => errors.push(error.message));
              await page.addInitScript("globalThis.__name = (fn) => fn");
              await page.addInitScript(
                ({ key, gatewayUrl }) =>
                  localStorage.setItem(
                    key,
                    JSON.stringify({ gatewayUrl, lobsterPetVisits: false }),
                  ),
                {
                  key: controlUiBundledSettingsStorageKey(slot.url),
                  gatewayUrl: controlUiBundledGatewayUrl(slot.url),
                },
              );
              await installTalkPerfFixture(page, values.counters, suspendNativeAudio);
              const gateway = await installMockGateway(page, {
                serverBuildId: slot.buildId,
                serverVersion: slot.version,
                historyMessages: [TALK_READY_HISTORY_MESSAGE],
                methodResponses: {
                  "talk.catalog": {
                    realtime: {
                      activeProvider: "openai",
                      ready: true,
                      providers: [{ id: "openai", label: "Synthetic OpenAI" }],
                    },
                  },
                  "talk.client.create": {
                    provider: "openai",
                    transport: "webrtc",
                    clientSecret: "synthetic-benchmark",
                    voiceSessionId: "voice-bench",
                  },
                },
              });
              cdp = await observation.context.newCDPSession(page);
              browserCdp = await observation.browser.newBrowserCDPSession();
              await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
              if (viewport.name === "mobile") {
                await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
              }
              await page.goto(new URL("/chat", slot.url).href);
              await waitForTalkReady(page);
              const waitForPrecacheAndQuiet = async () => {
                await page.evaluate(async () => {
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    await Promise.race([
                      navigator.serviceWorker.ready,
                      new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(
                          () =>
                            reject(
                              new Error("Service worker did not become ready within 10 seconds"),
                            ),
                          10_000,
                        );
                      }),
                    ]);
                  } finally {
                    clearTimeout(timer);
                  }
                });
                await page.waitForFunction(
                  () => navigator.serviceWorker.controller?.state === "activated",
                );
                const workerUrl = await page.evaluate(async (expectedBuild) => {
                  const worker = navigator.serviceWorker.controller!;
                  const channel = new MessageChannel();
                  try {
                    await new Promise<void>((resolve, reject) => {
                      const timer = setTimeout(
                        () => reject(new Error("Service worker precache probe did not reply")),
                        10_000,
                      );
                      channel.port1.addEventListener(
                        "message",
                        (event) => {
                          clearTimeout(timer);
                          if (
                            event.data?.type === "sw-updated" &&
                            event.data.version === expectedBuild
                          ) {
                            resolve();
                          } else {
                            reject(
                              new Error("Service worker precache probe has a different build"),
                            );
                          }
                        },
                        { once: true },
                      );
                      channel.port1.start();
                      worker.postMessage(
                        {
                          type: "sw-version-probe",
                          offlinePrecache: {
                            saveData: navigator.connection?.saveData === true,
                            effectiveType: navigator.connection?.effectiveType,
                          },
                        },
                        [channel.port2],
                      );
                    });
                    return worker.scriptURL;
                  } finally {
                    channel.port1.close();
                    channel.port2.close();
                  }
                }, slot.buildId);
                const worker = observation.context
                  .serviceWorkers()
                  .find((candidate) => candidate.url() === workerUrl);
                if (!worker) {
                  throw new Error("Active service worker inspector is unavailable");
                }
                // Network quiet can fall between cache hashing/writes. Observe the
                // existing work to completion without adding a production test API.
                const precache = await worker.evaluate<{
                  cacheName: string;
                  expectedAssets: number;
                  cachedAssets: number;
                  offlineShell: boolean;
                }>(`(async () => {
                  await Promise.all([offlinePreparation, deferredPreparation]);
                  const inventory = [...OFFLINE_BOOT.assets, ...OFFLINE_BOOT.deferredAssets];
                  const cached = await Promise.all(inventory.map(asset => caches.match(
                    new URL(asset.path, new URL(SCOPE_PATH, SCOPE_URL)).href,
                    { cacheName: CACHE_NAME },
                  )));
                  return {
                    cacheName: CACHE_NAME,
                    expectedAssets: inventory.length,
                    cachedAssets: cached.filter(Boolean).length,
                    offlineShell: Boolean(await caches.match(OFFLINE_SHELL_URL, { cacheName: CACHE_NAME })),
                  };
                })()`);
                await writeFile(
                  path.join(artifactDir, `${browserPrefix}.precache.json`),
                  JSON.stringify(precache, null, 2),
                );
                if (!precache.offlineShell || precache.cachedAssets !== precache.expectedAssets) {
                  throw new Error(
                    `Service worker precache is incomplete: ${JSON.stringify(precache)}`,
                  );
                }
                await network.waitForQuiet();
              };
              if (values["startup-warm-cache"]) {
                await waitForPrecacheAndQuiet();
              }
              let beforeStartup: Awaited<ReturnType<typeof metrics>> | undefined;
              let beforeStartupNetwork: ReturnType<typeof network.snapshot> | undefined;
              let startupHostLoadAverage: number[] | undefined;
              if (values["startup-latency"]) {
                await page.evaluate(() => {
                  const probe: Window["talkStartupProbe"] = (window.talkStartupProbe = {
                    gestureAtMs: null,
                    firstPlayAtMs: null,
                    readyAtMs: null,
                    readinessObservedAtMs: null,
                    playCalls: [],
                  });
                  document.addEventListener(
                    "pointerdown",
                    () => {
                      probe.gestureAtMs = performance.now();
                    },
                    { capture: true, once: true },
                  );
                  // Preserve the fixture's muted native play wrapper and its own timing.
                  // oxlint-disable-next-line typescript/unbound-method
                  const play = HTMLMediaElement.prototype.play;
                  HTMLMediaElement.prototype.play = function () {
                    const invokedAtMs = performance.now();
                    const src = this.getAttribute("src") ?? this.currentSrc;
                    const call: NativePlayAttempt = {
                      callIndex: probe.playCalls.length,
                      sourceKind: this.srcObject ? "srcObject" : src ? "src" : "empty",
                      srcKind: src.startsWith("data:audio/wav")
                        ? "data-audio-wav"
                        : src.startsWith("data:")
                          ? "data"
                          : src.startsWith("blob:")
                            ? "blob"
                            : src
                              ? "url"
                              : "empty",
                      srcObjectKind: this.srcObject
                        ? this.srcObject instanceof MediaStream
                          ? "MediaStream"
                          : "other"
                        : null,
                      connectedAtInvoke: this.isConnected,
                      invokedAtMs,
                      resolvedAtMs: null,
                      rejectedAtMs: null,
                      rejectionName: null,
                    };
                    probe.playCalls.push(call);
                    const first = probe.firstPlayAtMs === null;
                    if (first) {
                      probe.firstPlayAtMs = invokedAtMs;
                    }
                    const rejected = (error: unknown) => {
                      call.rejectedAtMs = performance.now();
                      call.rejectionName = error instanceof Error ? error.name : typeof error;
                    };
                    let promise: Promise<void>;
                    try {
                      promise = play.call(this);
                    } catch (error) {
                      rejected(error);
                      throw error;
                    }
                    void promise.then(() => {
                      call.resolvedAtMs = performance.now();
                      if (first) {
                        probe.readyAtMs = call.resolvedAtMs;
                      }
                    }, rejected);
                    return promise;
                  };
                });
                await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
                startupHostLoadAverage = os.loadavg();
                beforeStartupNetwork = network.snapshot();
                beforeStartup = await metrics(cdp);
              }
              await page
                .getByRole("button", {
                  name: viewport.name === "mobile" ? "Tap to talk" : "Start voice input",
                  exact: true,
                })
                .click();
              await gateway.waitForRequest("talk.client.create");
              await page.waitForFunction(() =>
                Boolean(window.openclawTalkBench.peer?.remoteDescription),
              );
              await page.evaluate(() => {
                if (!window.openclawTalkBench.peer) {
                  throw new Error("Synthetic Talk peer was not created");
                }
                window.openclawTalkBench.peer.channel.dispatchEvent(new Event("open"));
              });
              await page.getByRole("button", { name: "Stop voice input", exact: true }).waitFor();
              await page.waitForFunction(() => document.querySelector("audio")?.paused === false);
              const playback = await page.waitForFunction(() => {
                const attempts = window.openclawTalkBench.playbackStartLatenciesMs;
                if (!attempts.length || !attempts.every((value) => value >= 0)) {
                  return undefined;
                }
                if (window.talkStartupProbe) {
                  window.talkStartupProbe.readinessObservedAtMs ??= performance.now();
                }
                return attempts;
              });
              const playLatenciesMs = await playback.jsonValue();
              let startup: StartupLatency | undefined;
              if (beforeStartup) {
                const afterStartup = await metrics(cdp);
                const afterStartupNetwork = network.snapshot();
                const gesture = await page.evaluate(() => window.talkStartupProbe);
                const remote = gesture.playCalls.find(
                  (call) => call.sourceKind === "srcObject" && call.srcObjectKind === "MediaStream",
                );
                const first = gesture.playCalls[0];
                if (
                  gesture.gestureAtMs === null ||
                  gesture.readyAtMs === null ||
                  gesture.firstPlayAtMs === null ||
                  gesture.readinessObservedAtMs === null ||
                  !first ||
                  !remote ||
                  remote.resolvedAtMs === null ||
                  !beforeStartupNetwork ||
                  !startupHostLoadAverage
                ) {
                  throw new Error("Incomplete startup gesture probe");
                }
                startup = {
                  mode: startupMode,
                  legacyFirstPlayUnlock: {
                    callIndex: first.callIndex,
                    sourceKind: first.sourceKind,
                    srcKind: first.srcKind,
                    gestureToReadyMs: gesture.readyAtMs - gesture.gestureAtMs,
                    gestureToPlayMs: gesture.firstPlayAtMs - gesture.gestureAtMs,
                    playToReadyMs: gesture.readyAtMs - gesture.firstPlayAtMs,
                  },
                  remoteStream: {
                    callIndex: remote.callIndex,
                    gestureToPlayMs: remote.invokedAtMs - gesture.gestureAtMs,
                    gestureToReadyMs: remote.resolvedAtMs - gesture.gestureAtMs,
                    playToReadyMs: remote.resolvedAtMs - remote.invokedAtMs,
                  },
                  readinessWait: {
                    afterGestureMs: gesture.readinessObservedAtMs - gesture.gestureAtMs,
                    afterRemotePlayResolutionMs:
                      gesture.readinessObservedAtMs - remote.resolvedAtMs,
                  },
                  nativePlayCalls: summarizeNativePlays(gesture),
                  hostLoadAverage: startupHostLoadAverage,
                  network: {
                    assetGets: afterStartupNetwork.assetGets - beforeStartupNetwork.assetGets,
                    serviceWorkerAssetGets:
                      afterStartupNetwork.serviceWorkerAssetGets -
                      beforeStartupNetwork.serviceWorkerAssetGets,
                    pendingAssetGetCountAtStart: beforeStartupNetwork.pendingAssetGets,
                    pendingAssetGetCountAtEnd: afterStartupNetwork.pendingAssetGets,
                  },
                  gestureToReadyMs: gesture.readyAtMs - gesture.gestureAtMs,
                  gestureToPlayMs: gesture.firstPlayAtMs - gesture.gestureAtMs,
                  playToReadyMs: gesture.readyAtMs - gesture.firstPlayAtMs,
                  taskMs: (afterStartup.TaskDuration! - beforeStartup.TaskDuration!) * 1000,
                  scriptMs: (afterStartup.ScriptDuration! - beforeStartup.ScriptDuration!) * 1000,
                  styleMs:
                    (afterStartup.RecalcStyleDuration! - beforeStartup.RecalcStyleDuration!) * 1000,
                };
                await writeFile(
                  path.join(artifactDir, `${browserPrefix}.startup.json`),
                  JSON.stringify(
                    { comparison, side, pair, viewport: viewport.name, cpuRate, ...startup },
                    null,
                    2,
                  ),
                );
              }
              if (!playLatenciesMs) {
                throw new Error("Native playback did not start");
              }
              startupPlayback.push({
                comparison,
                side,
                pair,
                viewport: viewport.name,
                cpuRate,
                playLatenciesMs,
                startup,
              });
              await playback.dispose();
              if (compareCss && comparison === "AB" && side === 1) {
                await page.addStyleTag({ content: compareCss });
              }
              if (compareScript && comparison === "AB" && side === 1) {
                await page.evaluate(compareScript);
              }
              if (!values["startup-warm-cache"]) {
                await waitForPrecacheAndQuiet();
              } else {
                // Start may still issue lazy module GETs against the warmed cache.
                await network.waitForQuiet();
              }
              const loadedAssets = await page.evaluate(() =>
                performance.getEntriesByType("resource").map((entry) => entry.name),
              );
              for (const asset of new Set(loadedAssets)) {
                if (!asset.startsWith(assetBase) || !new URL(asset).pathname.endsWith(".js")) {
                  continue;
                }
                const name = new URL(asset).pathname.slice(new URL(assetBase).pathname.length);
                if (!(name in slot.assetHashes)) {
                  const content = slot.directory
                    ? await readFile(path.join(slot.directory, "assets", name))
                    : new Uint8Array(await (await fetch(asset)).arrayBuffer());
                  slot.assetHashes[name] = createHash("sha256").update(content).digest("hex");
                }
              }
              await writeFile(
                path.join(artifactDir, "manifest.json"),
                JSON.stringify(manifest, null, 2),
              );
              // Retire startup paint/audio-service setup before the first measured state.
              await new Promise((resolve) => {
                setTimeout(resolve, 1000);
              });
              await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
              if (values.trace) {
                cdp.on("LayerTree.layerTreeDidChange", collectLayers);
                await cdp.send("LayerTree.enable");
                layerTreeEnabled = true;
              }
              for (const state of states) {
                const hidden = state === "hidden" || state === "hidden-transcribing";
                const externalTranscripts =
                  state === "hidden-transcribing" ||
                  (state === "transcribing" && values["external-transcripts"]);
                const prefix = path.join(artifactDir, `${browserPrefix}-${state}`);
                const row: Sample = {
                  comparison,
                  side,
                  pair,
                  viewport: viewport.name,
                  cpuRate,
                  state,
                  status: "failed",
                  prefix,
                  hostLoadAverage: os.loadavg(),
                  nativeAudio: { enabled: suspendNativeAudio },
                };
                results.push(row);
                let windowId: number | undefined;
                let transcriptRow: ElementHandle<HTMLElement | SVGElement> | null = null;
                try {
                  await page.evaluate(
                    ({ phase, externalTranscripts: external }) =>
                      window.openclawTalkBench.setState(phase, external),
                    { phase: state, externalTranscripts },
                  );
                  if (externalTranscripts) {
                    // Establish a row before hiding so reveal also proves identity retention.
                    const seed = await page.evaluate(() =>
                      window.openclawTalkBench.deliverTranscriptChunk(false),
                    );
                    await page.waitForFunction(
                      (token) =>
                        [...document.querySelectorAll(".agent-chat__voice-turn-text")].some(
                          (element) => element.textContent?.includes(token),
                        ),
                      seed,
                      { polling: 50 },
                    );
                    transcriptRow = await page
                      .locator(".agent-chat__voice-turn")
                      .last()
                      .elementHandle();
                  }
                  if (!values["focused-stop"]) {
                    await page.mouse.move(1, 1);
                    await page
                      .getByRole("button", { name: "Stop voice input", exact: true })
                      .evaluate((element) => {
                        if (element === document.activeElement && element instanceof HTMLElement) {
                          element.blur();
                        }
                      });
                    await page.locator("openclaw-tooltip[open]").waitFor({ state: "detached" });
                  }
                  await new Promise((resolve) => {
                    setTimeout(resolve, 350);
                  });
                  if (state !== "transcribing" && state !== "hidden-transcribing") {
                    await page
                      .locator(".agent-chat__voice-turn-stream")
                      .waitFor({ state: "detached" });
                  }
                  if (state !== "speaking") {
                    await page.waitForFunction(
                      () =>
                        document
                          .querySelector(".agent-chat__voice-activity")
                          ?.getAttribute("data-level") === "0",
                    );
                  }
                  if (state === "responding") {
                    await page
                      .locator('.agent-chat__voice-activity[data-status="thinking"]')
                      .waitFor({ state: "visible" });
                    await page.waitForFunction(
                      () => document.querySelector("audio")?.paused === false,
                    );
                  }
                  if (hidden) {
                    ({ windowId } = await cdp.send("Browser.getWindowForTarget"));
                    await cdp.send("Browser.setWindowBounds", {
                      windowId,
                      bounds: { windowState: "minimized" },
                    });
                    await page.waitForFunction(() => document.hidden, undefined, { polling: 50 });
                  } else {
                    await page.waitForFunction(() => !document.hidden, undefined, { polling: 50 });
                  }
                  if (values["focused-stop"]) {
                    const stop = page.getByRole("button", {
                      name: "Stop voice input",
                      exact: true,
                    });
                    await page.mouse.move(1, 1);
                    if (await stop.evaluate((element) => element === document.activeElement)) {
                      // Re-enter through native keyboard navigation to establish focus modality.
                      await page.keyboard.press("Tab");
                      await page.keyboard.press("Shift+Tab");
                    } else {
                      let focused = false;
                      for (let step = 0; step < 120; step++) {
                        await page.keyboard.press("Tab");
                        if (await stop.evaluate((element) => element === document.activeElement)) {
                          focused = true;
                          break;
                        }
                      }
                      if (!focused) {
                        throw new Error("Stop was not reachable within 120 native Tab steps");
                      }
                    }
                    await page
                      .locator("openclaw-tooltip")
                      .filter({ has: stop })
                      .locator('.tooltip-surface[data-phase="open"]')
                      .waitFor({ state: "visible" });
                  }
                  const nativeAudio = suspendNativeAudio
                    ? await page.evaluate(async () => ({
                        beforeSuspension: window.openclawTalkBench.readNativeAudioState(),
                        atStart: await window.openclawTalkBench.suspendNativeAudio(),
                      }))
                    : undefined;
                  row.nativeAudio = { enabled: suspendNativeAudio, ...nativeAudio };
                  if (values["first-pair-screenshots"] && pair === 0 && !hidden) {
                    await page.screenshot({ path: `${prefix}.png` });
                  }
                  await network.waitForQuiet();
                  events.length = 0;
                  if (values.trace) {
                    cdp.on("Tracing.dataCollected", collectTrace);
                    await cdp.send("Tracing.start", {
                      categories:
                        "toplevel,devtools.timeline,blink,blink.animations,blink.user_timing,cc,v8,audio,webaudio,webrtc,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-v8.gc",
                      transferMode: "ReportEvents",
                    });
                    tracing = true;
                    await cdp.send("Profiler.enable");
                    await cdp.send("Profiler.start");
                    await page.evaluate(() => performance.mark("openclaw-talk-sample"));
                    const reportedLayers = latestLayers;
                    if (!reportedLayers) {
                      throw new Error("LayerTree did not report layers for the Talk sample");
                    }
                    // Collect metadata before fixture.start() opens the counter window.
                    const { root } = await cdp.send("DOM.getDocument");
                    const selector = ".agent-chat__voice-activity-bar";
                    const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
                      nodeId: root.nodeId,
                      selector,
                    });
                    if (nodeIds.length !== 7) {
                      throw new Error(`Expected seven Talk meter spans, found ${nodeIds.length}`);
                    }
                    const meterNodes = await Promise.all(
                      nodeIds.map(async (nodeId: number, index: number) => {
                        const { node } = await cdp!.send("DOM.describeNode", { nodeId });
                        return {
                          index,
                          nodeId,
                          backendNodeId: node.backendNodeId,
                          layerIds: reportedLayers
                            .filter((layer) => layer.backendNodeId === node.backendNodeId)
                            .map((layer) => layer.layerId),
                        };
                      }),
                    );
                    const layers = await Promise.all(
                      reportedLayers.map(async (layer) => {
                        let reasons;
                        try {
                          reasons = await cdp!.send("LayerTree.compositingReasons", {
                            layerId: layer.layerId,
                          });
                        } catch (error) {
                          if (
                            !(error instanceof Error) ||
                            !error.message.includes("No layer matching given id found")
                          ) {
                            throw error;
                          }
                          return {
                            layerId: layer.layerId,
                            backendNodeId: layer.backendNodeId,
                            stale: true,
                          };
                        }
                        return {
                          layerId: layer.layerId,
                          backendNodeId: layer.backendNodeId,
                          compositingReasons: reasons.compositingReasons,
                          compositingReasonIds: reasons.compositingReasonIds,
                        };
                      }),
                    );
                    await writeFile(
                      `${prefix}.layers.json`,
                      JSON.stringify(
                        { phase: "pre-sample", selector, meterNodes, layers },
                        null,
                        2,
                      ),
                    );
                  }
                  await page.evaluate(
                    ({ frames, observeTranscripts, observeTooltips, focusedStop }) =>
                      window.openclawTalkBench.start(
                        frames,
                        observeTranscripts,
                        observeTooltips,
                        focusedStop,
                      ),
                    {
                      frames: values.frames,
                      observeTranscripts:
                        (state === "transcribing" || state === "hidden-transcribing") &&
                        (!externalTranscripts || values.counters),
                      observeTooltips: true,
                      focusedStop: values["focused-stop"],
                    },
                  );
                  const beforeProcesses = await processes(browserCdp);
                  const beforeWakeups = wakeups(beforeProcesses);
                  const beforeNetwork = network.snapshot();
                  const before = await metrics(cdp);
                  const start = performance.now();
                  let offeredChunks = 0;
                  const offeredAt: number[] = [];
                  if (externalTranscripts) {
                    const plannedChunks = Math.floor(durationMs / transcriptPeriodMs);
                    for (let index = 0; index < plannedChunks; index++) {
                      await new Promise((resolve) => {
                        setTimeout(
                          resolve,
                          Math.max(0, start + index * transcriptPeriodMs - performance.now()),
                        );
                      });
                      offeredAt.push(performance.now() - start);
                      await page.evaluate(
                        (expectedHidden) =>
                          window.openclawTalkBench.deliverTranscriptChunk(expectedHidden),
                        hidden,
                      );
                      offeredChunks++;
                    }
                  }
                  await new Promise((resolve) => {
                    setTimeout(resolve, Math.max(0, start + durationMs - performance.now()));
                  });
                  const after = await metrics(cdp);
                  const wallMs = performance.now() - start;
                  const afterNetwork = network.snapshot();
                  const assetGetCount = afterNetwork.assetGets - beforeNetwork.assetGets;
                  const networkValidity = {
                    valid: beforeNetwork.pendingAssetGets === 0 && assetGetCount === 0,
                    assetGetCount,
                    serviceWorkerAssetGetCount:
                      afterNetwork.serviceWorkerAssetGets - beforeNetwork.serviceWorkerAssetGets,
                    pendingAssetGetCountAtStart: beforeNetwork.pendingAssetGets,
                  };
                  const afterProcesses = await processes(browserCdp);
                  const afterWakeups = wakeups(afterProcesses);
                  const interval = {
                    startUs: before.Timestamp! * 1000000,
                    endUs: after.Timestamp! * 1000000,
                  };
                  const proof = await page.evaluate(
                    ({ readExternalTranscript, checkNativeAudio }) => {
                      const snapshot = window.openclawTalkBench;
                      if (readExternalTranscript) {
                        // CPU timing ended above; this observation must not tax each hidden chunk.
                        snapshot.readTranscriptDom();
                      }
                      snapshot.stop();
                      const {
                        analyserReads,
                        meterStyleMutations,
                        meterDataMutations,
                        intervalCallbacks,
                        timeoutCallbacks,
                        animationCallbacks,
                        mutationObserverCallbacks,
                        resizeObserverCallbacks,
                        intersectionObserverCallbacks,
                        transcriptChunks,
                        transcriptDomMutations,
                        transcriptPendingChunks,
                        tooltipOpenAtStart,
                        tooltipOpenAtEnd,
                        tooltipChanges,
                        focusedStop,
                        transcriptLatenciesMs,
                        frameTimes,
                      } = snapshot;
                      const counts = {
                        analyserReads,
                        meterStyleMutations,
                        meterDataMutations,
                        intervalCallbacks,
                        timeoutCallbacks,
                        animationCallbacks,
                        mutationObserverCallbacks,
                        resizeObserverCallbacks,
                        intersectionObserverCallbacks,
                        transcriptChunks,
                        transcriptDomMutations,
                        transcriptPendingChunks,
                        tooltipOpenAtStart,
                        tooltipOpenAtEnd,
                        tooltipChanges,
                        focusedStop,
                        transcriptObservedChunks: transcriptChunks - transcriptPendingChunks,
                        transcriptLatenciesMs,
                        frameTimes,
                      };
                      return {
                        ...counts,
                        nativeAudio: checkNativeAudio ? snapshot.readNativeAudioState() : undefined,
                        visibility: document.visibilityState,
                      };
                    },
                    {
                      readExternalTranscript: externalTranscripts,
                      checkNativeAudio: suspendNativeAudio,
                    },
                  );
                  if (tracing) {
                    const { profile } = await cdp.send("Profiler.stop");
                    await writeFile(`${prefix}.cpu-profile.json`, JSON.stringify(profile));
                    const clipped = clipInteractionCpuProfile(
                      profile,
                      interval.startUs,
                      interval.endUs,
                    );
                    const mapped = slot.directory
                      ? await mapColdLoadCpuProfile(clipped, {
                          assetBaseUrl: new URL("assets/", slot.url).href,
                          assetDirectory: path.join(slot.directory, "assets"),
                        })
                      : { profile: clipped, mappedFrames: 0, unmappedFrames: clipped.nodes.length };
                    await writeFile(
                      `${prefix}.hotspots.json`,
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
                      cdp!.once("Tracing.tracingComplete", () => resolve());
                    });
                    await cdp.send("Tracing.end");
                    await complete;
                    tracing = false;
                    await writeFile(
                      `${prefix}.trace.json`,
                      JSON.stringify({ traceEvents: events }),
                    );
                    cdp.removeListener("Tracing.dataCollected", collectTrace);
                  }
                  const delta = (name: string) => (after[name]! - before[name]!) * 1000;
                  const intervalSeconds = (interval.endUs - interval.startUs) / 1_000_000;
                  const processCpu = processCpuDelta(beforeProcesses, afterProcesses);
                  const rendererCpuMs = processCpu.byTypeMs.renderer ?? 0;
                  const frameGaps = proof.frameTimes
                    .slice(1)
                    .map((time, index) => time - proof.frameTimes[index]!);
                  const traceEvents = events.map(prepareColdLoadTraceEvent);
                  const mainThread = traceEvents.find(
                    ({ name }) => name === "openclaw-talk-sample",
                  );
                  if (values.trace && !mainThread) {
                    throw new Error("Missing Talk page main-thread trace marker");
                  }
                  // Canonical top-level events exclude nested V8 phases and other renderers.
                  const gc = traceEvents.filter(
                    ({ name, ph, ts, dur, pid, tid }) =>
                      pid === mainThread?.pid &&
                      tid === mainThread.tid &&
                      ts < interval.endUs &&
                      ts + (dur ?? 0) > interval.startUs &&
                      ph === "X" &&
                      (name === "MinorGC" || name === "MajorGC"),
                  );
                  Object.assign(row, {
                    status: "passed",
                    network: networkValidity,
                    interval,
                    wallMs,
                    taskMs: delta("TaskDuration"),
                    scriptMs: delta("ScriptDuration"),
                    layoutMs: delta("LayoutDuration"),
                    styleMs: delta("RecalcStyleDuration"),
                    taskMsPerSecond: delta("TaskDuration") / intervalSeconds,
                    scriptMsPerSecond: delta("ScriptDuration") / intervalSeconds,
                    styleMsPerSecond: delta("RecalcStyleDuration") / intervalSeconds,
                    rendererCpuMs,
                    processCpu,
                    nativeAudio: nativeAudio
                      ? { enabled: true, ...nativeAudio, atEnd: proof.nativeAudio }
                      : { enabled: false },
                    heapDeltaBytes: after.JSHeapUsedSize! - before.JSHeapUsedSize!,
                    proof,
                    transcriptDelivery: externalTranscripts
                      ? {
                          offeredChunks,
                          periodMs: transcriptPeriodMs,
                          offeredAt,
                          actualRateHz: offeredChunks / (wallMs / 1000),
                        }
                      : undefined,
                    transcriptDomLatency:
                      !externalTranscripts || values.counters
                        ? distribution(proof.transcriptLatenciesMs)
                        : undefined,
                    frameGapsMs: distribution(frameGaps),
                    fps: frameGaps.length
                      ? 1000 / (frameGaps.reduce((a, b) => a + b, 0) / frameGaps.length)
                      : undefined,
                    gc: values.trace
                      ? {
                          count: gc.length,
                          ms:
                            gc.reduce(
                              (total, event) =>
                                total +
                                Math.min(interval.endUs, event.ts + (event.dur ?? 0)) -
                                Math.max(interval.startUs, event.ts),
                              0,
                            ) / 1000,
                        }
                      : undefined,
                    wakeups: wakeupDelta(beforeWakeups, afterWakeups),
                    errors,
                  });
                  if (!networkValidity.valid) {
                    throw new Error(
                      `Talk sample contains background asset traffic: ${JSON.stringify(networkValidity)}`,
                    );
                  }
                  if (errors.length) {
                    throw new Error(`Page errors: ${errors.join("; ")}`);
                  }
                  if (proof.visibility !== (hidden ? "hidden" : "visible")) {
                    throw new Error("Observation did not retain the intended document visibility");
                  }
                  if (
                    suspendNativeAudio &&
                    (!proof.nativeAudio?.allLiveContextsSuspended ||
                      !proof.nativeAudio.allAudioPaused)
                  ) {
                    throw new Error("Native audio resumed during counterfactual observation");
                  }
                  if (
                    values["focused-stop"] &&
                    (!proof.focusedStop?.documentFocusedAtStart ||
                      !proof.focusedStop.documentFocusedAtEnd ||
                      !proof.focusedStop.triggerFocusedAtStart ||
                      !proof.focusedStop.triggerFocusedAtEnd ||
                      !proof.focusedStop.tooltipOpenAtStart ||
                      !proof.focusedStop.tooltipOpenAtEnd ||
                      proof.focusedStop.invalidated ||
                      proof.tooltipChanges)
                  ) {
                    throw new Error(
                      "Focused Stop observation lost document, trigger, or tooltip focus",
                    );
                  }
                  if (
                    !values["focused-stop"] &&
                    (proof.tooltipOpenAtStart || proof.tooltipOpenAtEnd || proof.tooltipChanges)
                  ) {
                    throw new Error("Ordinary observation did not retain neutral tooltips");
                  }
                  if (externalTranscripts) {
                    if (proof.transcriptChunks !== offeredChunks) {
                      throw new Error("External transcript delivery invariant failed");
                    }
                    if (
                      hidden &&
                      values["expect-hidden-parked"] &&
                      (comparison === "AB" ? side === 1 : slots.length === 1) &&
                      (proof.transcriptObservedChunks !== 0 || proof.transcriptDomMutations !== 0)
                    ) {
                      throw new Error("Candidate rendered transcript chunks while hidden");
                    }
                    if (windowId !== undefined) {
                      await page.evaluate(() => window.openclawTalkBench.armReveal());
                      const beforeReveal = await metrics(cdp);
                      const revealStartedAt = performance.now();
                      await cdp.send("Browser.setWindowBounds", {
                        windowId,
                        bounds: { windowState: "normal" },
                      });
                      const restoreCommandAfterMs = performance.now() - revealStartedAt;
                      windowId = undefined;
                      await page.waitForFunction(() => !document.hidden, undefined, {
                        polling: 50,
                      });
                      const visibleObservedAfterMs = performance.now() - revealStartedAt;
                      await page.waitForFunction(
                        () => window.openclawTalkBench.reveal?.transcriptDomAtMs !== undefined,
                        undefined,
                        { polling: 50 },
                      );
                      const observedAfterMs = performance.now() - revealStartedAt;
                      await page.waitForFunction(
                        () => window.openclawTalkBench.reveal?.secondFrameAtMs !== undefined,
                        undefined,
                        { polling: 50 },
                      );
                      const browserReveal = await page.evaluate(() => {
                        const reveal = window.openclawTalkBench.reveal;
                        if (
                          !reveal ||
                          reveal.transcriptDomAtMs === undefined ||
                          reveal.secondFrameAtMs === undefined ||
                          window.openclawTalkBench.transcriptPendingChunks !== 0
                        ) {
                          throw new Error("Browser reveal did not complete transcript catchup");
                        }
                        return reveal;
                      });
                      const afterReveal = await metrics(cdp);
                      const revealDelta = (name: string) =>
                        (afterReveal[name]! - beforeReveal[name]!) * 1000;
                      const revealCpu = {
                        taskMs: revealDelta("TaskDuration"),
                        scriptMs: revealDelta("ScriptDuration"),
                        layoutMs: revealDelta("LayoutDuration"),
                        styleMs: revealDelta("RecalcStyleDuration"),
                      };
                      row.reveal = {
                        restoreCommandAfterMs,
                        visibleObservedAfterMs,
                        observedAfterMs,
                        frameAfterMs: performance.now() - revealStartedAt,
                        browser: browserReveal,
                        ...revealCpu,
                        observedChunks: await page.evaluate(
                          () =>
                            window.openclawTalkBench.transcriptChunks -
                            window.openclawTalkBench.transcriptPendingChunks,
                        ),
                      };
                      row.hiddenAndReveal = {
                        taskMs: delta("TaskDuration") + revealCpu.taskMs,
                        scriptMs: delta("ScriptDuration") + revealCpu.scriptMs,
                        layoutMs: delta("LayoutDuration") + revealCpu.layoutMs,
                        styleMs: delta("RecalcStyleDuration") + revealCpu.styleMs,
                      };
                      if (values["first-pair-screenshots"] && pair === 0) {
                        await page.screenshot({ path: `${prefix}.revealed.png` });
                      }
                    } else if (proof.transcriptPendingChunks !== 0) {
                      throw new Error("Visible transcript did not display every offered chunk");
                    }
                    const rowRetained = await transcriptRow?.evaluate(
                      (element) =>
                        element.isConnected &&
                        element ===
                          [...document.querySelectorAll(".agent-chat__voice-turn")].at(-1),
                    );
                    if (!rowRetained) {
                      throw new Error("Transcript streaming or reveal replaced its existing row");
                    }
                    row.transcriptRowRetained = true;
                  }
                  if (state === "transcribing" && !proof.transcriptLatenciesMs.length) {
                    throw new Error("No streamed transcript reached the production DOM");
                  }
                  console.log(
                    `${browserPrefix} ${state}: task=${String(row.taskMs)}ms renderer=${rendererCpuMs}ms analyser=${proof.analyserReads}`,
                  );
                } catch (error) {
                  row.status = "failed";
                  row.error = String(error);
                  await saveTalkFailure(page, prefix, error);
                  throw error;
                } finally {
                  await transcriptRow?.dispose();
                  if (windowId !== undefined) {
                    await cdp.send("Browser.setWindowBounds", {
                      windowId,
                      bounds: { windowState: "normal" },
                    });
                  }
                  await writeFile(`${prefix}.json`, JSON.stringify(row, null, 2));
                }
              }
              await page.getByRole("button", { name: "Stop voice input", exact: true }).click();
              await gateway.waitForRequest("talk.client.close");
            } catch (error) {
              await writeFile(
                path.join(artifactDir, `${browserPrefix}.setup-or-run.error.txt`),
                String(error),
              );
              throw error;
            } finally {
              if (values["startup-latency"]) {
                const probe = await startupPage
                  ?.evaluate(() => window.talkStartupProbe)
                  .catch(() => undefined);
                await writeFile(
                  path.join(artifactDir, `${browserPrefix}.native-play.json`),
                  JSON.stringify(
                    {
                      comparison,
                      side,
                      pair,
                      viewport: viewport.name,
                      cpuRate,
                      mode: startupMode,
                      scope: "Probe installation through Stop, or failure cleanup",
                      gestureObserved:
                        probe?.gestureAtMs !== null && probe?.gestureAtMs !== undefined,
                      playCalls: probe ? summarizeNativePlays(probe) : [],
                    },
                    null,
                    2,
                  ),
                );
              }
              if (tracing) {
                await cdp?.send("Tracing.end").catch(() => undefined);
              }
              try {
                if (layerTreeEnabled) {
                  await cdp?.send("LayerTree.disable");
                }
              } finally {
                cdp?.removeListener("LayerTree.layerTreeDidChange", collectLayers);
                await cdp?.detach();
                await browserCdp?.detach();
                await observation.close();
              }
            }
          }
        }
      }
    }
  }
} finally {
  const summary: unknown[] = [];
  for (const comparison of new Set(results.map((row) => row.comparison))) {
    for (const viewport of viewports) {
      for (const cpuRate of cpuRates) {
        for (const state of states) {
          const cell = results.filter(
            (row) =>
              row.comparison === comparison &&
              row.viewport === viewport.name &&
              row.cpuRate === cpuRate &&
              row.state === state &&
              row.status === "passed",
          );
          if (!cell.length) {
            continue;
          }
          const metricNames = [
            "taskMs",
            "scriptMs",
            "layoutMs",
            "styleMs",
            "taskMsPerSecond",
            "scriptMsPerSecond",
            "styleMsPerSecond",
            "rendererCpuMs",
            "wallMs",
          ];
          summary.push({
            comparison,
            interpretation: values["compare-suspend-native-audio"]
              ? "Native-audio counterfactual diagnostic; not product performance or latency evidence."
              : undefined,
            viewport: viewport.name,
            cpuRate,
            state,
            sides: [0, 1].map((side) => ({
              side,
              metrics: Object.fromEntries(
                metricNames.map((metric) => [
                  metric,
                  distribution(
                    cell.filter((row) => row.side === side).map((row) => row[metric] as number),
                  ),
                ]),
              ),
            })),
            pairedPercent: Object.fromEntries(
              metricNames.map((metric) => [
                metric,
                distribution(
                  Array.from({ length: pairs }, (_, pair) => {
                    const baseline = cell.find((row) => row.pair === pair && row.side === 0)?.[
                      metric
                    ] as number | undefined;
                    const candidate = cell.find((row) => row.pair === pair && row.side === 1)?.[
                      metric
                    ] as number | undefined;
                    return baseline && candidate !== undefined
                      ? (candidate / baseline - 1) * 100
                      : undefined;
                  }).filter((value): value is number => value !== undefined),
                ),
              ]),
            ),
          });
        }
      }
    }
  }
  await writeFile(
    path.join(artifactDir, "results.json"),
    JSON.stringify(
      {
        planned:
          pairs *
            viewports.length *
            cpuRates.length *
            states.length *
            (slots.length === 2 ? 2 : 1) +
          (values.aa ? pairs * viewports.length * cpuRates.length * states.length * 2 : 0),
        executed: results.length,
        startupPlayback,
        results,
        summary,
      },
      null,
      2,
    ),
  );
  for (const slot of slots) {
    await slot.close?.();
  }
}
