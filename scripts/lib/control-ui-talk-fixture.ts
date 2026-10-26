import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
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
export type TalkBenchState = "listening" | "speaking" | "transcribing" | "idle" | "hidden";
export type TalkBenchProof = {
  peer?: { channel: EventTarget; remoteDescription: RTCSessionDescriptionInit | null };
  analyserReads: number;
  meterStyleMutations: number;
  meterDataMutations: number;
  intervalCallbacks: number;
  timeoutCallbacks: number;
  animationCallbacks: number;
  transcriptChunks: number;
  transcriptLatenciesMs: number[];
  playbackStartLatenciesMs: number[];
  frameTimes: number[];
  setState: (state: TalkBenchState) => void;
  start: (frames: boolean) => void;
  stop: () => void;
};

declare global {
  interface Window {
    /** Installed before navigation by this benchmark's browser fixture. */
    openclawTalkBench: TalkBenchProof;
  }
}
/** Real Web Audio signal; provider data-channel messages use the existing E2E contract. */
export async function installTalkPerfFixture(page: Page, includeCounters: boolean) {
  await page.addInitScript(
    ({ counters }) => {
      let context: AudioContext | undefined;
      let gain: GainNode | undefined;
      let modulationDepth: GainNode | undefined;
      let stream: MediaStream | undefined;
      let sequence = 0;
      let turn = 0;
      let activeTranscript:
        | {
            id: string;
            text: string;
          }
        | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let frame: number | undefined;
      let observer: MutationObserver | undefined;
      let observing = false;
      const pending = new Map<string, number>();
      const proof: TalkBenchProof = {
        analyserReads: 0,
        meterStyleMutations: 0,
        meterDataMutations: 0,
        intervalCallbacks: 0,
        timeoutCallbacks: 0,
        animationCallbacks: 0,
        transcriptChunks: 0,
        transcriptLatenciesMs: [],
        playbackStartLatenciesMs: [],
        frameTimes: [],
        setState(state) {
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
          const send = (event: unknown) => {
            if (!proof.peer) {
              throw new Error("Synthetic Talk peer was not created");
            }
            proof.peer.channel.dispatchEvent(
              new MessageEvent("message", { data: JSON.stringify(event) }),
            );
          };
          if (activeTranscript) {
            send({
              type: "response.output_audio_transcript.done",
              item_id: activeTranscript.id,
              transcript: activeTranscript.text,
            });
            activeTranscript = undefined;
          }
          send({ type: "input_audio_buffer.speech_started" });
          if (state === "transcribing") {
            const id = `bench-response-${++turn}`;
            activeTranscript = { id, text: "" };
            send({
              type: "conversation.item.added",
              previous_item_id: null,
              item: { id, type: "message", role: "assistant", content: [] },
            });
            const tick = () => {
              const token = `voice${String(++sequence).padStart(6, "0")}.`;
              if (observing) {
                pending.set(token, performance.now());
                proof.transcriptChunks++;
              }
              activeTranscript!.text += `${token} `;
              send({
                type: "response.output_audio_transcript.delta",
                item_id: id,
                delta: `${token} `,
              });
              timer = setTimeout(tick, 50);
            };
            tick();
          }
        },
        start(frames) {
          observing = true;
          proof.analyserReads =
            proof.intervalCallbacks =
            proof.timeoutCallbacks =
            proof.animationCallbacks =
              0;
          proof.transcriptChunks = 0;
          proof.meterStyleMutations = proof.meterDataMutations = 0;
          proof.transcriptLatenciesMs = [];
          proof.frameTimes = [];
          observer = new MutationObserver((records) => {
            if (counters) {
              for (const record of records) {
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
          });
          observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: counters,
            attributeFilter: counters ? ["style", "data-level", "data-status"] : undefined,
          });
          if (frames) {
            const tick = (time: number) => {
              proof.frameTimes.push(time);
              frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
          }
        },
        stop() {
          observing = false;
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (frame !== undefined) {
            cancelAnimationFrame(frame);
          }
          observer?.disconnect();
        },
      };
      window.openclawTalkBench = proof;
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
    { counters: includeCounters },
  );
  await page.route("https://api.openai.com/v1/realtime/calls", (route) =>
    route.fulfill({ status: 200, contentType: "application/sdp", body: "answer-sdp" }),
  );
}
export async function saveTalkFailure(page: Page, prefix: string, error: unknown) {
  await writeFile(`${prefix}.error.txt`, String(error));
  await page.screenshot({ path: `${prefix}.failure.png` }).catch(() => undefined);
}
