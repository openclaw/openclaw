// Production Talk renderer with native synthetic audio and the existing E2E provider contract.
// CPU comparisons: --pairs 10 (or 20) --aa. Diagnostic passes: --trace/--counters/--frames.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { CDPSession } from "playwright";
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
    output: { type: "string", default: ".artifacts/control-ui-talk" },
    pairs: { type: "string", default: "10" },
    "duration-ms": { type: "string", default: "5000" },
    viewport: { type: "string", default: "both" },
    "cpu-throttle": { type: "string", default: "1,4" },
    states: { type: "string", default: "listening,speaking,transcribing,idle,hidden" },
    aa: { type: "boolean", default: false },
    sample: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    counters: { type: "boolean", default: false },
    frames: { type: "boolean", default: false },
    "process-wakeups": { type: "boolean", default: false },
    "first-pair-screenshots": { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});
const pairs = values.sample ? 1 : Number(values.pairs);
const durationMs = values.sample ? 1000 : Number(values["duration-ms"]);
const cpuRates = values["cpu-throttle"].split(",").map(Number);
const states = values.states.split(",") as TalkBenchState[];
const compareCss = values["compare-css-file"]
  ? await readFile(values["compare-css-file"], "utf8")
  : undefined;
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(durationMs) ||
  durationMs < 1000 ||
  cpuRates.some((rate) => !Number.isFinite(rate) || rate < 1) ||
  states.some(
    (state) => !["listening", "speaking", "transcribing", "idle", "hidden"].includes(state),
  ) ||
  !["desktop", "mobile", "both"].includes(values.viewport)
) {
  throw new Error("Invalid benchmark selection");
}
if (values.frames && states.some((state) => state === "hidden" || state === "idle")) {
  throw new Error(
    "--frames adds animation wakeups: select active states only for a separate diagnostic pass",
  );
}
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
  directory?: string;
  close?: () => Promise<void>;
}> = [];
type ProcessInfo = {
  id: number;
  type: string;
  cpuTime: number;
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
const results: Sample[] = [];
const startupPlayback: Array<{
  comparison: string;
  side: number;
  pair: number;
  viewport: string;
  cpuRate: number;
  playLatenciesMs: number[];
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
      close,
    });
  }
  if (!slots.length) {
    throw new Error("No bundle selected");
  }
  const manifest = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    slots: slots.map(({ url, buildId, version, indexSha256, directory }) => ({
      url,
      buildId,
      version,
      indexSha256,
      directory,
    })),
    pairs,
    durationMs,
    viewports,
    cpuRates,
    states,
    mode: values.trace || values.counters || values.frames ? "diagnostic" : "thread-cpu-comparison",
    instrumentation: {
      trace: values.trace,
      counters: values.counters,
      frameProbe: values.frames,
      processWakeups: values["process-wakeups"],
    },
    compareCss,
    contract:
      "Production renderer; native oscillator microphone and native audio-element playback; synthetic WebRTC/provider events. No real-provider, network, hardware microphone, end-to-end audio latency, or battery-life claim. Playback latency measures the local native play() promise, not network round-trip. Transcript latency is provider-event dispatch to DOM observation, not INP. Idle means a connected Talk session without audio/transcript work; hidden means a connected listening session in an actually hidden document. Speaking means input/playback with 0.8Hz amplitude modulation, silenced at the audio element. Frame probe adds its own RAF loop, so run separately. All timers/animations retain native clocks.",
    acceptance:
      "At least 10 interleaved pairs; aim for 40% active CPU reduction and near-zero idle/hidden renderer work. A clean >=5% CPU win may land; per-cell timing median regression <=5% with no p95 increase (or 20-pair confirmation). A/A identifies shared-host wall-time noise; never claim network/provider latency from this fixture.",
  };
  await writeFile(path.join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const comparisons = [...(slots.length === 2 ? ["AB"] : ["A"]), ...(values.aa ? ["AA"] : [])];
  for (const comparison of comparisons) {
    for (const viewport of viewports) {
      for (const cpuRate of cpuRates) {
        for (let pair = 0; pair < pairs; pair++) {
          // Reverse alternate pairs to remove consistently first/second browser bias.
          const sides = comparison === "A" ? [0] : pair % 2 ? [1, 0] : [0, 1];
          for (const side of sides) {
            const slot = slots[comparison === "AA" ? 0 : side]!;
            const browserPrefix = `${comparison}-${viewport.name}-${cpuRate}x-${pair}-${side}`;
            const observation = await launchTalkObservationBrowser(artifactDir, values.headed);
            let browserCdp: CDPSession | undefined;
            let cdp: CDPSession | undefined;
            let tracing = false;
            const events: unknown[] = [];
            const collectTrace = ({ value }: { value: unknown[] }) => {
              events.push(...value);
            };
            try {
              const page = await observation.context.newPage();
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
              await installTalkPerfFixture(page, values.counters);
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
                return attempts.length && attempts.every((value) => value >= 0)
                  ? attempts
                  : undefined;
              });
              const playLatenciesMs = await playback.jsonValue();
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
              });
              await playback.dispose();
              if (compareCss && comparison === "AB" && side === 1) {
                await page.addStyleTag({ content: compareCss });
              }
              await page.waitForLoadState("networkidle");
              // Retire startup paint/audio-service setup before the first measured state.
              await new Promise((resolve) => {
                setTimeout(resolve, 1000);
              });
              await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
              for (const state of states) {
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
                };
                results.push(row);
                let windowId: number | undefined;
                try {
                  await page.evaluate((phase) => window.openclawTalkBench.setState(phase), state);
                  await new Promise((resolve) => {
                    setTimeout(resolve, 350);
                  });
                  if (state !== "transcribing") {
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
                  if (state === "hidden") {
                    ({ windowId } = await cdp.send("Browser.getWindowForTarget"));
                    await cdp.send("Browser.setWindowBounds", {
                      windowId,
                      bounds: { windowState: "minimized" },
                    });
                    await page.waitForFunction(() => document.hidden);
                  } else {
                    await page.waitForFunction(() => !document.hidden);
                  }
                  if (values["first-pair-screenshots"] && pair === 0 && state !== "hidden") {
                    await page.screenshot({ path: `${prefix}.png` });
                  }
                  events.length = 0;
                  if (values.trace) {
                    cdp.on("Tracing.dataCollected", collectTrace);
                    await cdp.send("Tracing.start", {
                      categories:
                        "toplevel,devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.gc",
                      transferMode: "ReportEvents",
                    });
                    tracing = true;
                    await cdp.send("Profiler.enable");
                    await cdp.send("Profiler.start");
                    await page.evaluate(() => performance.mark("openclaw-talk-sample"));
                  }
                  await page.evaluate(
                    (frames) => window.openclawTalkBench.start(frames),
                    values.frames,
                  );
                  const beforeProcesses = await processes(browserCdp);
                  const beforeWakeups = wakeups(beforeProcesses);
                  const before = await metrics(cdp);
                  const start = performance.now();
                  await new Promise((resolve) => {
                    setTimeout(resolve, durationMs);
                  });
                  const after = await metrics(cdp);
                  const wallMs = performance.now() - start;
                  const afterProcesses = await processes(browserCdp);
                  const afterWakeups = wakeups(afterProcesses);
                  const interval = {
                    startUs: before.Timestamp! * 1000000,
                    endUs: after.Timestamp! * 1000000,
                  };
                  const proof = await page.evaluate(() => {
                    const snapshot = window.openclawTalkBench;
                    snapshot.stop();
                    const {
                      analyserReads,
                      meterStyleMutations,
                      meterDataMutations,
                      intervalCallbacks,
                      timeoutCallbacks,
                      animationCallbacks,
                      transcriptChunks,
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
                      transcriptChunks,
                      transcriptLatenciesMs,
                      frameTimes,
                    };
                    return { ...counts, visibility: document.visibilityState };
                  });
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
                  const initialRenderers = beforeProcesses.filter(
                    ({ type }) => type === "renderer",
                  );
                  const rendererCpuMs = initialRenderers.reduce((sum, initial) => {
                    const final = afterProcesses.find(({ id }) => id === initial.id);
                    if (!final) {
                      throw new Error("Renderer process disappeared during sample");
                    }
                    return sum + (final.cpuTime - initial.cpuTime) * 1000;
                  }, 0);
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
                    interval,
                    wallMs,
                    taskMs: delta("TaskDuration"),
                    scriptMs: delta("ScriptDuration"),
                    layoutMs: delta("LayoutDuration"),
                    styleMs: delta("RecalcStyleDuration"),
                    rendererCpuMs,
                    heapDeltaBytes: after.JSHeapUsedSize! - before.JSHeapUsedSize!,
                    proof,
                    transcriptDomLatency: distribution(proof.transcriptLatenciesMs),
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
                  if (errors.length) {
                    throw new Error(`Page errors: ${errors.join("; ")}`);
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
              if (tracing) {
                await cdp?.send("Tracing.end").catch(() => undefined);
              }
              await cdp?.detach();
              await browserCdp?.detach();
              await observation.close();
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
            "rendererCpuMs",
            "wallMs",
          ];
          summary.push({
            comparison,
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
