import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
import type {
  TalkSessionCancelOutputParams,
  TalkSessionCancelOutputResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  resolvePlaywrightChromiumExecutablePath,
  type MockGatewayWindow,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
/** Own a fresh browser with native visibility; Playwright's default launch forces focus. */
export async function launchTalkObservationBrowser(artifactDir: string, headed: boolean) {
  const profile = await mkdtemp(path.join(artifactDir, "browser-"));
  const child = spawn(
    resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--no-service-autorun",
      "--password-store=basic",
      "--use-mock-keychain",
      "--autoplay-policy=no-user-gesture-required",
      ...(!headed ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const stopped = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  async function close() {
    try {
      await browser?.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await stopped;
      await rm(profile, { recursive: true, force: true });
    }
  }
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error("Observation browser did not start")),
        30000,
      );
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Observation browser exited"));
      });
      const readEndpoint = (data: Buffer) => {
        output += data.toString();
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/u);
        if (match) {
          clearTimeout(timeout);
          child.stderr.off("data", readEndpoint);
          child.stderr.resume();
          resolve(match[1]!);
        }
      };
      child.stderr.on("data", readEndpoint);
    });
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Missing native browser context");
    }
    return { browser, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export type TalkBenchState =
  | "listening"
  | "speaking"
  | "responding"
  | "transcribing"
  | "idle"
  | "hidden"
  | "hidden-transcribing";
type TalkRevealProof = {
  visibilityAtMs: number;
  transcriptDomAtMs?: number;
  secondFrameAtMs?: number;
  visibilityToDomMs?: number;
  visibilityToFrameMs?: number;
  domToFrameMs?: number;
  observedChunks?: number;
};
type TalkNativeAudioState = {
  contextStates: AudioContextState[];
  contextCount: number;
  liveContextCount: number;
  audioElementCount: number;
  pausedAudioElementCount: number;
  allLiveContextsSuspended: boolean;
  allAudioPaused: boolean;
};
type PcmInputRecord = {
  id: number;
  callbackAtMs: number;
  audioTime: number;
  state: AudioContextState;
  length: number;
  rate: number;
  appendAtMs?: number;
  timestamp?: number;
  bytes?: number;
  sessionId?: string;
};
type PcmOutputRecord = {
  id: number;
  eventAtMs: number;
  startAtMs?: number;
  when?: number;
  audioTime?: number;
  state?: AudioContextState;
  length?: number;
  rate?: number;
  starts: number;
  endedAtMs?: number;
  endedAudioTime?: number;
  stopped?: boolean;
  natural?: boolean;
};
type PcmUiRecord = { status: string | null; level: string | null };
type PcmCancellationRecord = {
  atMs: number;
  turnId?: string;
  reason?: string;
  status: NonNullable<TalkSessionCancelOutputResult["status"]>;
  observing: boolean;
};
type TalkBenchProof = {
  recordPcmAppend(params: { audioBase64: string; timestamp: number; sessionId: string }): void;
  settlePcmAppends(): Promise<void>;
  cancelOutput(params: TalkSessionCancelOutputParams): TalkSessionCancelOutputResult;
  readPcm(): {
    startMs: number;
    endMs: number;
    input: PcmInputRecord[];
    output: PcmOutputRecord[];
    cancellations: PcmCancellationRecord[];
    unmatchedAppends: number;
    uiAtStart?: PcmUiRecord;
    uiAtEnd?: PcmUiRecord;
  };
  readPcmCleanup(): {
    contexts: AudioContextState[];
    tracks: MediaStreamTrackState[];
    callbacks: number;
    appends: number;
    starts: number;
  };
  peer?: { channel: EventTarget; remoteDescription: RTCSessionDescriptionInit | null };
  analyserReads: number;
  meterStyleMutations: number;
  meterDataMutations: number;
  intervalCallbacks: number;
  timeoutCallbacks: number;
  animationCallbacks: number;
  mutationObserverCallbacks: number;
  resizeObserverCallbacks: number;
  intersectionObserverCallbacks: number;
  transcriptChunks: number;
  transcriptDomMutations: number;
  readonly transcriptPendingChunks: number;
  tooltipOpenAtStart: boolean;
  readonly tooltipOpenAtEnd: boolean;
  tooltipChanges: number;
  focusedStop?: {
    documentFocusedAtStart: boolean;
    documentFocusedAtEnd: boolean;
    triggerFocusedAtStart: boolean;
    triggerFocusedAtEnd: boolean;
    tooltipOpenAtStart: boolean;
    tooltipOpenAtEnd: boolean;
    invalidated: boolean;
  };
  transcriptLatenciesMs: number[];
  playbackStartLatenciesMs: number[];
  frameTimes: number[];
  reveal?: TalkRevealProof;
  armReveal: () => void;
  readNativeAudioState: () => TalkNativeAudioState;
  suspendNativeAudio: () => Promise<TalkNativeAudioState>;
  setState: (state: TalkBenchState, externalTranscripts?: boolean) => void;
  deliverTranscriptChunk: (expectedHidden?: boolean) => string;
  readTranscriptDom: () => void;
  start: (
    frames: boolean,
    observeTranscripts?: boolean,
    observeTooltips?: boolean,
    focusedStop?: boolean,
  ) => void;
  stop: () => void;
};

declare global {
  interface Window {
    /** Installed before navigation by this benchmark's browser fixture. */
    openclawTalkBench: TalkBenchProof;
  }
}
/** Real Web Audio signal; provider data-channel messages use the existing E2E contract. */
export async function installTalkPerfFixture(
  page: Pick<Page, "addInitScript" | "route">,
  includeCounters: boolean,
  suspendNativeAudio: boolean,
  transportMode: "webrtc" | "gateway-relay" = "webrtc",
) {
  await page.addInitScript(
    ({ counters, suspendAudio, transport }) => {
      const NativeMutationObserver = window.MutationObserver;
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
      const nativeAudioContexts: AudioContext[] = [];
      if (suspendAudio || transport === "gateway-relay") {
        // Retain native contexts for PCM observations and the suspension counterfactual.
        window.AudioContext = new Proxy(window.AudioContext, {
          construct(target, args, newTarget) {
            const created: AudioContext = Reflect.construct(target, args, newTarget);
            nativeAudioContexts.push(created);
            return created;
          },
        });
      }
      let context: AudioContext | undefined;
      let gain: GainNode | undefined;
      let modulationDepth: GainNode | undefined;
      let stream: MediaStream | undefined;
      let sequence = 0;
      let turn = 0;
      let respondingId: string | undefined;
      let pcmStartMs = 0,
        pcmEndMs = 0,
        pcmSequence = 0;
      let pcmCallbacks = 0,
        pcmAppends = 0,
        pcmStarts = 0,
        unmatchedAppends = 0;
      const pendingInputs: PcmInputRecord[] = [];
      let settlePcmAppend: (() => void) | undefined;
      let activeOutput: PcmOutputRecord | undefined;
      let pcmInput: PcmInputRecord[] = [],
        pcmOutput: PcmOutputRecord[] = [];
      const cancellations: PcmCancellationRecord[] = [];
      let pcmUiAtStart: PcmUiRecord | undefined, pcmUiAtEnd: PcmUiRecord | undefined;
      const readPcmUi = (): PcmUiRecord => {
        const activity = document.querySelector(".agent-chat__voice-activity");
        return {
          status: activity?.getAttribute("data-status") ?? null,
          level: activity?.getAttribute("data-level") ?? null,
        };
      };
      const silentPcm100ms = transport === "gateway-relay" ? btoa("\0".repeat(4_800)) : "";
      const sendRelay = (payload: Record<string, unknown>) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
        gateway.emit("talk.event", { relaySessionId: "relay-bench", ...payload });
      };
      let previousTranscriptId: string | null = null;
      let activeTranscript:
        | {
            id: string;
            text: string;
          }
        | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let frame: number | undefined;
      let observer: MutationObserver | undefined;
      let tooltipObserver: MutationObserver | undefined;
      let finishFocusedStop: (() => void) | undefined;
      let revealObserver: MutationObserver | undefined;
      let revealFrame: number | undefined;
      let revealVisibilityListener: ((event: Event) => void) | undefined;
      let observing = false;
      const pending = new Map<string, number>();
      const clearRevealObservation = () => {
        revealObserver?.disconnect();
        revealObserver = undefined;
        if (revealFrame !== undefined) {
          nativeCancelAnimationFrame(revealFrame);
          revealFrame = undefined;
        }
        if (revealVisibilityListener) {
          document.removeEventListener("visibilitychange", revealVisibilityListener);
          revealVisibilityListener = undefined;
        }
      };
      const send = (event: unknown) => {
        if (!proof.peer) {
          throw new Error("Synthetic Talk peer was not created");
        }
        proof.peer.channel.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(event) }),
        );
      };
      const finishResponding = (cancelled = false) => {
        if (respondingId === undefined) {
          return;
        }
        if (transport === "gateway-relay") {
          sendRelay({
            type: "clear",
            talkEvent: { turnId: respondingId, ...(cancelled ? { type: "turn.cancelled" } : {}) },
          });
          respondingId = undefined;
          return;
        }
        send({
          type: "response.done",
          response: { id: respondingId, status: "completed", output: [] },
        });
        respondingId = undefined;
      };
      const proof: TalkBenchProof = {
        recordPcmAppend(params) {
          pcmAppends++;
          const record = pendingInputs.shift();
          if (!record) {
            if (observing) {
              unmatchedAppends++;
            }
            return;
          }
          record.appendAtMs = performance.now();
          record.timestamp = params.timestamp;
          record.sessionId = params.sessionId;
          const padding = params.audioBase64.endsWith("==")
            ? 2
            : params.audioBase64.endsWith("=")
              ? 1
              : 0;
          record.bytes = (params.audioBase64.length * 3) / 4 - padding;
          settlePcmAppend?.();
        },
        settlePcmAppends() {
          if (pcmInput.every((record) => record.appendAtMs !== undefined)) {
            return Promise.resolve();
          }
          return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              settlePcmAppend = undefined;
              reject(new Error("Observed PCM callbacks did not reach appendAudio"));
            }, 1000);
            settlePcmAppend = () => {
              if (pcmInput.every((record) => record.appendAtMs !== undefined)) {
                clearTimeout(timeout);
                settlePcmAppend = undefined;
                resolve();
              }
            };
          });
        },
        cancelOutput({ turnId, reason }) {
          const status = !respondingId
            ? "idle"
            : turnId && turnId !== respondingId
              ? "stale"
              : "applied";
          cancellations.push({ atMs: performance.now(), turnId, reason, status, observing });
          if (status !== "applied") {
            return { ok: true, status };
          }
          const cancelledTurn = respondingId;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          finishResponding(true);
          return { ok: true, status, turnId: cancelledTurn };
        },
        readPcm: () => ({
          startMs: pcmStartMs,
          endMs: pcmEndMs,
          input: pcmInput,
          output: pcmOutput,
          cancellations,
          unmatchedAppends,
          uiAtStart: pcmUiAtStart,
          uiAtEnd: pcmUiAtEnd,
        }),
        readPcmCleanup: () => ({
          contexts: nativeAudioContexts.map((ctx) => ctx.state),
          tracks: stream?.getTracks().map((track) => track.readyState) ?? [],
          callbacks: pcmCallbacks,
          appends: pcmAppends,
          starts: pcmStarts,
        }),
        analyserReads: 0,
        meterStyleMutations: 0,
        meterDataMutations: 0,
        intervalCallbacks: 0,
        timeoutCallbacks: 0,
        animationCallbacks: 0,
        mutationObserverCallbacks: 0,
        resizeObserverCallbacks: 0,
        intersectionObserverCallbacks: 0,
        transcriptChunks: 0,
        transcriptDomMutations: 0,
        get transcriptPendingChunks() {
          return pending.size;
        },
        tooltipOpenAtStart: false,
        get tooltipOpenAtEnd() {
          return document.querySelector("openclaw-tooltip[open]") !== null;
        },
        tooltipChanges: 0,
        transcriptLatenciesMs: [],
        playbackStartLatenciesMs: [],
        frameTimes: [],
        readNativeAudioState() {
          const contextStates = nativeAudioContexts.map((audioContext) => audioContext.state);
          const liveStates = contextStates.filter((state) => state !== "closed");
          const audioElements = [...document.querySelectorAll("audio")];
          const pausedAudioElementCount = audioElements.filter((audio) => audio.paused).length;
          return {
            contextStates,
            contextCount: contextStates.length,
            liveContextCount: liveStates.length,
            audioElementCount: audioElements.length,
            pausedAudioElementCount,
            allLiveContextsSuspended:
              liveStates.length > 0 && liveStates.every((state) => state === "suspended"),
            allAudioPaused:
              audioElements.length > 0 && pausedAudioElementCount === audioElements.length,
          };
        },
        async suspendNativeAudio() {
          if (!suspendAudio) {
            throw new Error("Native audio suspension requires the comparison's suspended side");
          }
          for (const audio of document.querySelectorAll("audio")) {
            audio.pause();
          }
          await Promise.all(
            nativeAudioContexts
              .filter((audioContext) => audioContext.state === "running")
              .map((audioContext) => audioContext.suspend()),
          );
          const state = proof.readNativeAudioState();
          if (!state.allLiveContextsSuspended || !state.allAudioPaused) {
            throw new Error(`Native audio suspension was incomplete: ${JSON.stringify(state)}`);
          }
          return state;
        },
        armReveal() {
          clearRevealObservation();
          proof.reveal = undefined;
          if (!document.hidden) {
            throw new Error("Reveal observation must be armed while hidden");
          }
          const onVisibility = (event: Event) => {
            if (document.hidden) {
              return;
            }
            document.removeEventListener("visibilitychange", onVisibility);
            revealVisibilityListener = undefined;
            const reveal: TalkRevealProof = { visibilityAtMs: event.timeStamp };
            proof.reveal = reveal;
            const observeDom = () => {
              if (reveal.transcriptDomAtMs !== undefined) {
                return;
              }
              proof.readTranscriptDom();
              if (pending.size) {
                return;
              }
              const domAtMs = performance.now();
              reveal.transcriptDomAtMs = domAtMs;
              reveal.visibilityToDomMs = domAtMs - reveal.visibilityAtMs;
              reveal.observedChunks = proof.transcriptChunks;
              revealObserver?.disconnect();
              revealObserver = undefined;
              revealFrame = nativeRequestAnimationFrame(() => {
                revealFrame = nativeRequestAnimationFrame(() => {
                  const frameAtMs = performance.now();
                  reveal.secondFrameAtMs = frameAtMs;
                  reveal.visibilityToFrameMs = frameAtMs - reveal.visibilityAtMs;
                  reveal.domToFrameMs = frameAtMs - domAtMs;
                  clearRevealObservation();
                });
              });
            };
            revealObserver = new NativeMutationObserver(observeDom);
            revealObserver.observe(document.body, {
              subtree: true,
              childList: true,
              characterData: true,
            });
            observeDom();
          };
          revealVisibilityListener = onVisibility;
          document.addEventListener("visibilitychange", onVisibility);
        },
        setState(state, externalTranscripts = false) {
          clearRevealObservation();
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (!gain) {
            throw new Error("Synthetic microphone not acquired");
          }
          // Native oscillator is silent to speakers: it feeds only a MediaStreamDestination.
          gain.gain.value = state === "speaking" ? 0.12 : 0;
          if (modulationDepth) {
            modulationDepth.gain.value = state === "speaking" ? 0.1 : 0;
          }
          if (transport === "gateway-relay") {
            finishResponding();
            if (state === "responding") {
              respondingId = `bench-pcm-turn-${++turn}`;
              const tick = () => {
                activeOutput = { id: ++pcmSequence, eventAtMs: performance.now(), starts: 0 };
                if (observing) {
                  pcmOutput.push(activeOutput);
                }
                try {
                  sendRelay({
                    type: "audio",
                    audioBase64: silentPcm100ms,
                    talkEvent: { turnId: respondingId },
                  });
                } finally {
                  activeOutput = undefined;
                }
                timer = setTimeout(tick, 100);
              };
              tick();
            }
            return;
          }
          if (activeTranscript) {
            send({
              type: "response.output_audio_transcript.done",
              item_id: activeTranscript.id,
              transcript: activeTranscript.text,
            });
            previousTranscriptId = activeTranscript.id;
            activeTranscript = undefined;
          }
          finishResponding();
          send({ type: "input_audio_buffer.speech_started" });
          if (state === "responding") {
            respondingId = `bench-audio-response-${++turn}`;
            send({ type: "response.created", response: { id: respondingId } });
          } else if (state === "transcribing" || state === "hidden-transcribing") {
            const id = `bench-response-${++turn}`;
            activeTranscript = { id, text: "" };
            send({
              type: "conversation.item.added",
              previous_item_id: previousTranscriptId,
              item: { id, type: "message", role: "assistant", content: [] },
            });
            const tick = () => {
              proof.deliverTranscriptChunk();
              timer = setTimeout(tick, 50);
            };
            if (!externalTranscripts && state === "transcribing") {
              tick();
            }
          }
        },
        deliverTranscriptChunk(expectedHidden) {
          if (!activeTranscript) {
            throw new Error("No synthetic transcript is active");
          }
          if (expectedHidden !== undefined && document.hidden !== expectedHidden) {
            throw new Error("Document visibility changed during external transcript delivery");
          }
          const token = `voice${String(++sequence).padStart(6, "0")}.`;
          if (observing) {
            pending.set(token, performance.now());
            proof.transcriptChunks++;
          }
          activeTranscript.text += `${token} `;
          send({
            type: "response.output_audio_transcript.delta",
            item_id: activeTranscript.id,
            delta: `${token} `,
          });
          return token;
        },
        readTranscriptDom() {
          if (!pending.size) {
            return;
          }
          const text = [...document.querySelectorAll(".agent-chat__voice-turn-text")]
            .map((element) => element.textContent)
            .join(" ");
          for (const [token, sentAt] of pending) {
            if (text.includes(token)) {
              proof.transcriptLatenciesMs.push(performance.now() - sentAt);
              pending.delete(token);
            }
          }
        },
        start(frames, observeTranscripts = false, observeTooltips = false, focusedStop = false) {
          observing = true;
          pending.clear();
          proof.analyserReads =
            proof.intervalCallbacks =
            proof.timeoutCallbacks =
            proof.animationCallbacks =
            proof.mutationObserverCallbacks =
            proof.resizeObserverCallbacks =
            proof.intersectionObserverCallbacks =
              0;
          pcmInput = [];
          pcmOutput = [];
          unmatchedAppends = 0;
          pcmStartMs = performance.now();
          pcmEndMs = 0;
          pcmUiAtStart = transport === "gateway-relay" ? readPcmUi() : undefined;
          pcmUiAtEnd = undefined;
          proof.transcriptChunks = 0;
          proof.transcriptDomMutations = 0;
          proof.meterStyleMutations = proof.meterDataMutations = 0;
          proof.transcriptLatenciesMs = [];
          proof.frameTimes = [];
          proof.tooltipChanges = 0;
          proof.tooltipOpenAtStart = observeTooltips && proof.tooltipOpenAtEnd;
          proof.focusedStop = undefined;
          const trigger = focusedStop ? document.activeElement : null;
          const tooltip = trigger?.closest("openclaw-tooltip");
          if (focusedStop) {
            if (
              !(trigger instanceof HTMLButtonElement) ||
              trigger.getAttribute("aria-label") !== "Stop voice input" ||
              !tooltip
            ) {
              throw new Error("Native keyboard focus did not reach the Stop trigger");
            }
            const focus = {
              documentFocusedAtStart: document.hasFocus(),
              documentFocusedAtEnd: false,
              triggerFocusedAtStart: document.activeElement === trigger,
              triggerFocusedAtEnd: false,
              tooltipOpenAtStart: tooltip.hasAttribute("open"),
              tooltipOpenAtEnd: false,
              invalidated: false,
            };
            proof.focusedStop = focus;
            const invalidate = () => {
              focus.invalidated = true;
            };
            window.addEventListener("blur", invalidate);
            trigger.addEventListener("focusout", invalidate);
            finishFocusedStop = () => {
              focus.documentFocusedAtEnd = document.hasFocus();
              focus.triggerFocusedAtEnd = document.activeElement === trigger;
              focus.tooltipOpenAtEnd = tooltip.hasAttribute("open");
              window.removeEventListener("blur", invalidate);
              trigger.removeEventListener("focusout", invalidate);
            };
          }
          if (observeTooltips) {
            tooltipObserver = new MutationObserver((records) => {
              proof.tooltipChanges += records.filter(
                (record) =>
                  record.target instanceof Element &&
                  record.target.localName === "openclaw-tooltip" &&
                  (!focusedStop || record.target === tooltip),
              ).length;
            });
            tooltipObserver.observe(document.body, {
              subtree: true,
              attributes: true,
              attributeFilter: ["open"],
            });
          }
          if (counters || observeTranscripts) {
            observer = new MutationObserver((records) => {
              if (counters) {
                for (const record of records) {
                  const element =
                    record.target instanceof Element ? record.target : record.target.parentElement;
                  if (element?.closest(".agent-chat__voice-turns")) {
                    proof.transcriptDomMutations++;
                  }
                  if (
                    record.type !== "attributes" ||
                    !(record.target instanceof Element) ||
                    !record.target.closest("openclaw-microphone-activity")
                  ) {
                    continue;
                  }
                  if (record.attributeName === "style") {
                    proof.meterStyleMutations++;
                  } else if (record.attributeName?.startsWith("data-")) {
                    proof.meterDataMutations++;
                  }
                }
              }
              if (observeTranscripts) {
                proof.readTranscriptDom();
              }
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: counters,
              attributeFilter: counters ? ["style", "data-level", "data-status"] : undefined,
            });
          }
          if (frames) {
            const tick = (time: number) => {
              proof.frameTimes.push(time);
              frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
          }
        },
        stop() {
          pcmEndMs = performance.now();
          pcmUiAtEnd = transport === "gateway-relay" ? readPcmUi() : undefined;
          observing = false;
          clearRevealObservation();
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (frame !== undefined) {
            cancelAnimationFrame(frame);
          }
          observer?.disconnect();
          tooltipObserver?.disconnect();
          finishFocusedStop?.();
          finishFocusedStop = undefined;
          // Observation ends after CPU sampling, before the native Stop action.
          finishResponding();
        },
      };
      window.openclawTalkBench = proof;
      if (transport === "gateway-relay") {
        const outputRecords = new WeakMap<AudioBufferSourceNode, PcmOutputRecord>();
        // Observe before the production property callback; preserve the native node and callback.
        // oxlint-disable-next-line typescript/unbound-method
        const createProcessor = AudioContext.prototype.createScriptProcessor;
        AudioContext.prototype.createScriptProcessor = function (...args) {
          const node = createProcessor.apply(this, args);
          node.addEventListener("audioprocess", (event) => {
            if (!node.onaudioprocess) {
              return;
            }
            pcmCallbacks++;
            const record: PcmInputRecord = {
              id: ++pcmSequence,
              callbackAtMs: performance.now(),
              audioTime: this.currentTime,
              state: this.state,
              length: event.inputBuffer.length,
              rate: event.inputBuffer.sampleRate,
            };
            pendingInputs.push(record);
            if (observing) {
              pcmInput.push(record);
            }
          });
          return node;
        };
        // Only a source started synchronously by our current provider event belongs to this probe.
        // oxlint-disable-next-line typescript/unbound-method
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          const record = activeOutput;
          start.apply(this, args);
          if (!record || !this.buffer) {
            return;
          }
          outputRecords.set(this, record);
          pcmStarts++;
          Object.assign(record, {
            starts: record.starts + 1,
            startAtMs: performance.now(),
            when: args[0] ?? 0,
            audioTime: this.context.currentTime,
            state: this.context.state,
            length: this.buffer.length,
            rate: this.buffer.sampleRate,
          });
          this.addEventListener(
            "ended",
            () =>
              Object.assign(record, {
                endedAtMs: performance.now(),
                endedAudioTime: this.context.currentTime,
                natural:
                  !record.stopped &&
                  this.context.currentTime + 1 / record.rate! >=
                    Math.max(record.when!, record.audioTime!) + record.length! / record.rate!,
              }),
            { once: true },
          );
        };
        // An ended event can arrive late after explicit cancellation; do not call it completion.
        // oxlint-disable-next-line typescript/unbound-method
        const stop = AudioBufferSourceNode.prototype.stop;
        AudioBufferSourceNode.prototype.stop = function (...args) {
          stop.apply(this, args);
          const record = outputRecords.get(this);
          if (record && record.endedAtMs === undefined) {
            record.stopped = true;
          }
        };
      }
      // Preserve the native method; call() below supplies the audio element receiver.
      // oxlint-disable-next-line typescript/unbound-method
      const nativePlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = async function () {
        // Exercise native playback without playing synthetic tones through the host's speakers.
        this.volume = 0;
        const startedAt = performance.now();
        const index = proof.playbackStartLatenciesMs.length;
        proof.playbackStartLatenciesMs.push(-1);
        await nativePlay.call(this);
        proof.playbackStartLatenciesMs[index] = performance.now() - startedAt;
      };
      // The original native method is called below with its analyser receiver.
      // oxlint-disable-next-line typescript/unbound-method
      const nativeAnalyse = AnalyserNode.prototype.getFloatTimeDomainData;
      AnalyserNode.prototype.getFloatTimeDomainData = function (samples) {
        if (observing) {
          proof.analyserReads++;
        }
        return nativeAnalyse.call(this, samples);
      };
      if (counters) {
        function countObserverCallbacks<
          Constructor extends
            | typeof MutationObserver
            | typeof ResizeObserver
            | typeof IntersectionObserver,
        >(
          constructor: Constructor,
          counter:
            | "mutationObserverCallbacks"
            | "resizeObserverCallbacks"
            | "intersectionObserverCallbacks",
        ): Constructor {
          return new Proxy(constructor, {
            construct(target, args, newTarget) {
              const callback: unknown = args[0];
              if (typeof callback !== "function") {
                return Reflect.construct(target, args, newTarget);
              }
              // Preserve native construction, subclass prototypes, callback receiver, and options.
              return Reflect.construct(
                target,
                [
                  function (this: unknown, ...notifications: unknown[]) {
                    if (observing) {
                      proof[counter]++;
                    }
                    Reflect.apply(callback, this, notifications);
                  },
                  ...args.slice(1),
                ],
                newTarget,
              );
            },
          });
        }
        window.MutationObserver = countObserverCallbacks(
          window.MutationObserver,
          "mutationObserverCallbacks",
        );
        window.ResizeObserver = countObserverCallbacks(
          window.ResizeObserver,
          "resizeObserverCallbacks",
        );
        window.IntersectionObserver = countObserverCallbacks(
          window.IntersectionObserver,
          "intersectionObserverCallbacks",
        );
        const interval = window.setInterval.bind(window);
        const timeout = window.setTimeout.bind(window);
        const raf = window.requestAnimationFrame.bind(window);
        window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
          interval(
            typeof callback === "function"
              ? (...inner: unknown[]) => {
                  if (observing) {
                    proof.intervalCallbacks++;
                  }
                  callback(...inner);
                }
              : callback,
            delay,
            ...args,
          )) as typeof window.setInterval;
        window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
          timeout(
            typeof callback === "function"
              ? (...inner: unknown[]) => {
                  if (observing) {
                    proof.timeoutCallbacks++;
                  }
                  callback(...inner);
                }
              : callback,
            delay,
            ...args,
          )) as typeof window.setTimeout;
        window.requestAnimationFrame = (callback) =>
          raf((time) => {
            if (observing) {
              proof.animationCallbacks++;
            }
            callback(time);
          });
      }
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          context ??= new AudioContext();
          const oscillator = context.createOscillator();
          oscillator.frequency.value = 220;
          gain = context.createGain();
          gain.gain.value = 0;
          const destination = context.createMediaStreamDestination();
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          const modulation = context.createOscillator();
          modulation.frequency.value = 0.8;
          modulationDepth = context.createGain();
          modulationDepth.gain.value = 0;
          modulation.connect(modulationDepth).connect(gain.gain);
          modulation.start();
          await context.resume();
          stream = destination.stream;
          for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              stop();
              oscillator.stop();
              modulation.stop();
              void context?.close();
            };
          }
          return stream;
        },
      });
      class FakeChannel extends EventTarget {
        readyState = "open";
        send() {}
        close() {
          this.readyState = "closed";
        }
      }
      // Same offer/data-channel boundary as browser-talk-start-stop.fixtures.ts, with real audio.
      class FakePeerConnection extends EventTarget {
        connectionState = "new";
        channel = new FakeChannel();
        remoteDescription: RTCSessionDescriptionInit | null = null;
        constructor() {
          super();
          proof.peer = this;
        }
        addTrack() {}
        createDataChannel() {
          return this.channel;
        }
        async createOffer() {
          return { type: "offer", sdp: "offer-sdp" };
        }
        async setLocalDescription() {}
        async setRemoteDescription(value: RTCSessionDescriptionInit) {
          this.remoteDescription = value;
          const track = stream?.getAudioTracks()[0];
          if (!track) {
            throw new Error("Synthetic audio stream was not acquired");
          }
          // The production onTrack handler attaches this real stream to its native audio element.
          this.dispatchEvent(Object.assign(new Event("track"), { streams: [stream], track }));
        }
        close() {
          this.connectionState = "closed";
        }
      }
      Object.defineProperty(window, "RTCPeerConnection", {
        configurable: true,
        value: FakePeerConnection,
      });
    },
    { counters: includeCounters, suspendAudio: suspendNativeAudio, transport: transportMode },
  );
  await page.route("https://api.openai.com/v1/realtime/calls", (route) =>
    route.fulfill({ status: 200, contentType: "application/sdp", body: "answer-sdp" }),
  );
}
export async function saveTalkFailure(page: Page, prefix: string, error: unknown, cdp: CDPSession) {
  await writeFile(`${prefix}.error.txt`, String(error));
  const browser = await page
    .evaluate(() => ({
      visibility: document.visibilityState,
      documentHidden: document.hidden,
      documentFocused: document.hasFocus(),
      nativeAudio: window.openclawTalkBench?.readNativeAudioState(),
      pcm: window.openclawTalkBench?.readPcm(),
      cleanup: window.openclawTalkBench?.readPcmCleanup(),
      activity: [...document.querySelectorAll(".agent-chat__voice-activity")].map((element) => ({
        status: element.getAttribute("data-status"),
        level: element.getAttribute("data-level"),
      })),
    }))
    .catch((captureError: unknown) => ({ captureError: String(captureError) }));
  const nativeWindow = await cdp
    .send("Browser.getWindowForTarget")
    .then(({ windowId }) => cdp.send("Browser.getWindowBounds", { windowId }))
    .catch((captureError: unknown) => ({ captureError: String(captureError) }));
  await writeFile(`${prefix}.failure.json`, JSON.stringify({ browser, nativeWindow }, null, 2));
  await page.screenshot({ path: `${prefix}.failure.png` }).catch(() => undefined);
}
