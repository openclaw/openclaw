// Opt-in, one fresh-process sample through the real public bridge and media worker.
// Fixture: "What is seven plus five?"; raw mono 8 kHz mu-law, at most 5 seconds.
// Convert once: ffmpeg -i question.wav -ac 1 -ar 8000 -c:a pcm_mulaw -f mulaw question.ulaw
// With OPENAI_API_KEY supplied by the caller, run from each pinned checkout:
// node --import ./scripts/tsx.mjs scripts/perf/gpt-live-telephony-input.ts --live --input question.ulaw
// Run five baseline/candidate pairs serially using the same fixture bytes.
// The latency endpoint is model audio arrival in onAudio, NOT handset playback.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const FRAME_BYTES = 160;
const FRAME_MS = 20;
const CAPTURE_FRAMES = 800;
const PRE_READY_FRAMES = 96;
const RMS_THRESHOLD = 0.01;
let setupStage = "options";

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      input: { type: "string" },
    },
  });
  if (!values.live || !values.input) {
    throw new Error("Use --live --input FILE");
  }
  setupStage = "credentials";
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }
  setupStage = "runtime-import";
  const [{ calculateMulawRms }, { openAIRealtimeHost }, { OpenAIQuicksilverGatewayBridge }] =
    await Promise.all([
      import("../../src/talk/audio-energy.ts"),
      import("../../extensions/openai/realtime-host.ts"),
      import("../../extensions/openai/realtime-quicksilver-gateway-bridge.ts"),
    ]);
  setupStage = "fixture";
  const audio = await readFile(values.input);
  if (audio.length < FRAME_BYTES || audio.length > 40_000) {
    throw new Error("Fixture must contain 20 ms to 5 s of raw mu-law audio");
  }
  const frames = Array.from({ length: Math.ceil(audio.length / FRAME_BYTES) }, (_, index) => {
    const frame = Buffer.alloc(FRAME_BYTES, 0xff);
    audio.copy(frame, 0, index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    return frame;
  });
  const isSpeech = (frame: Buffer) => calculateMulawRms(frame) >= RMS_THRESHOLD;
  const firstSpeechFrame = frames.findIndex(isSpeech);
  const lastSpeechFrame = frames.findLastIndex(isSpeech);
  if (lastSpeechFrame < 0) {
    throw new Error("Fixture has no audible speech");
  }
  const counts = { inputFrames: 0, outputChunks: 0, outputBytes: 0, audibleChunks: 0, closes: 0 };
  const errors = { provider: 0, run: 0, close: 0, delegation: 0 };
  let inputMarker = false;
  let answerMarker = false;
  let completedClose = false;
  let readyAt = 0;
  let speechStartAt = 0;
  let speechEndAt = 0;
  let firstAudibleAt = 0;
  let maxPacingLagMs = 0;
  let closeMs: number;
  const startedAt = performance.now();
  const cpuBefore = process.cpuUsage();
  const mainCpuBefore = process.threadCpuUsage();
  const hostLoadBefore = loadavg();
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-1",
      voice: "marin",
      connectTimeoutMs: 8_000,
      instructions:
        "Wait for the spoken arithmetic question. Answer only its result in English. Do not greet or delegate.",
      audioFormat: { encoding: "g711_ulaw", sampleRateHz: 8_000, channels: 1 },
      resolveAuth: async () => ({ type: "api-key", token: apiKey }),
      logger: { debug: () => {}, warn: () => {} },
      onReady: () => {
        readyAt = performance.now();
      },
      onAudio: (chunk) => {
        counts.outputChunks++;
        counts.outputBytes += chunk.length;
        if (isSpeech(chunk)) {
          counts.audibleChunks++;
          firstAudibleAt ||= performance.now();
        }
      },
      onClearAudio: () => {},
      onError: () => {
        errors.provider++;
      },
      onClose: (reason) => {
        counts.closes++;
        completedClose = reason === "completed";
      },
      onTranscript: (role, text, final) => {
        if (final && role === "user") {
          inputMarker ||= /\b(?:seven|7)\s*(?:plus|\+)\s*(?:five|5)\b/i.test(text);
        } else if (final) {
          answerMarker ||= /\b(?:twelve|12)\b/i.test(text);
        }
      },
      runAgentConsult: async () => {
        errors.delegation++;
        return { text: "Answer directly." };
      },
    },
    openAIRealtimeHost,
  );
  try {
    const silence = Buffer.alloc(FRAME_BYTES, 0xff);
    for (let index = 0; index < PRE_READY_FRAMES; index++) {
      bridge.sendAudio(silence);
      counts.inputFrames++;
    }
    await bridge.connect();
    for (let index = 0; index < CAPTURE_FRAMES; index++) {
      const due = readyAt + (index + 1) * FRAME_MS;
      await sleep(Math.max(0, due - performance.now()));
      if (errors.provider || counts.closes) {
        break;
      }
      const now = performance.now();
      maxPacingLagMs = Math.max(maxPacingLagMs, now - due);
      bridge.sendAudio(frames[index] ?? silence);
      counts.inputFrames++;
      if (index === firstSpeechFrame) {
        speechStartAt = now;
      }
      if (index === lastSpeechFrame) {
        speechEndAt = now;
      }
    }
  } catch {
    errors.run++;
  } finally {
    const closingAt = performance.now();
    try {
      await bridge.close();
    } catch {
      errors.close++;
    }
    closeMs = performance.now() - closingAt;
  }
  const cpu = process.cpuUsage(cpuBefore);
  const mainCpu = process.threadCpuUsage(mainCpuBefore);
  const pass =
    !Object.values(errors).some(Boolean) &&
    readyAt > 0 &&
    counts.inputFrames === PRE_READY_FRAMES + CAPTURE_FRAMES &&
    counts.closes === 1 &&
    completedClose &&
    speechEndAt > 0 &&
    firstAudibleAt >= speechStartAt &&
    firstAudibleAt > 0 &&
    inputMarker &&
    answerMarker;
  console.log(
    JSON.stringify({
      result: pass ? "pass" : "fail",
      counts,
      errors,
      inputMarker,
      answerMarker,
      completedClose,
      fixtureSha256: createHash("sha256").update(audio).digest("hex"),
      fixtureBytes: audio.length,
      preReadySilenceMs: PRE_READY_FRAMES * FRAME_MS,
      captureMs: CAPTURE_FRAMES * FRAME_MS,
      rmsThreshold: RMS_THRESHOLD,
      readyMs: readyAt ? readyAt - startedAt : null,
      sourceSpeechEndMs: speechEndAt ? speechEndAt - startedAt : null,
      modelAudioArrivalAfterSpeechEndMs:
        firstAudibleAt && speechEndAt ? firstAudibleAt - speechEndAt : null,
      closeMs,
      totalMs: performance.now() - startedAt,
      maxPacingLagMs,
      processCpuMs: (cpu.user + cpu.system) / 1_000,
      mainThreadCpuMs: (mainCpu.user + mainCpu.system) / 1_000,
      peakRssBytes: process.resourceUsage().maxRSS * 1_024,
      rssBytes: process.memoryUsage().rss,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      node: process.version,
    }),
  );
  process.exitCode = pass ? 0 : 1;
}
await main().catch(() => {
  console.log(JSON.stringify({ result: "fail", setupStage, setupErrors: 1 }));
  process.exitCode = 1;
});
