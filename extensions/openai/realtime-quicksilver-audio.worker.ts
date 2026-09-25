import { parentPort, workerData } from "node:worker_threads";
import {
  createRealtimeVoiceAudioPortSender,
  type RealtimeVoiceAudioOutputPort,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { OpenAIQuicksilverPendingAudio } from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverAudioPeer } from "./realtime-quicksilver-media.runtime.js";
import type {
  QuicksilverAudioWorkerCommand,
  QuicksilverAudioWorkerEvent,
} from "./realtime-quicksilver-peer.runtime.js";

const port = parentPort;
if (!port) {
  throw new Error("GPT-Live audio runtime requires a worker thread");
}
// SAFETY: OpenAIQuicksilverAudioPeer.create is the sole launcher and constructs this cloneable shape.
const options = workerData as {
  iceServers?: Parameters<typeof OpenAIQuicksilverAudioPeer.create>[0]["iceServers"];
  reportMediaErrors: boolean;
  output?: RealtimeVoiceAudioOutputPort;
};
const directOutput = options.output
  ? createRealtimeVoiceAudioPortSender(options.output)
  : undefined;
const controller = new AbortController();
const output = new OpenAIQuicksilverPendingAudio();
let peer: OpenAIQuicksilverAudioPeer | undefined;
let stopped = false;
let outputInFlight = false;
let outputGeneration = 0;
let rtpInFlight = false;
let mediaErrorInFlight = false;

function post(message: QuicksilverAudioWorkerEvent, transfer: ArrayBuffer[] = []): void {
  // Node MessagePort has no browser targetOrigin.
  port!.postMessage(message, transfer);
}

function flushOutput(): void {
  if (stopped || outputInFlight || output.length === 0) {
    return;
  }
  const audio = Buffer.alloc(output.length);
  output.readInto(audio);
  outputInFlight = true;
  post({ type: "audio", audio, generation: outputGeneration }, [audio.buffer]);
}

function stop(): void {
  if (stopped) {
    return;
  }
  stopped = true;
  controller.abort();
  peer?.close();
  output.clear();
  directOutput?.close();
  port!.close();
}

function fail(error: unknown): void {
  if (stopped) {
    return;
  }
  post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  stop();
}

// Listen before asynchronous codec setup so cancellation cannot strand a late peer.
port.on("message", (message: QuicksilverAudioWorkerCommand) => {
  if (stopped) {
    return;
  }
  if (message.type === "close") {
    stop();
    return;
  }
  if (!peer) {
    fail(new Error("GPT-Live audio worker is not ready"));
    return;
  }
  switch (message.type) {
    case "audio":
      peer.sendAudio(
        Buffer.from(message.audio.buffer, message.audio.byteOffset, message.audio.byteLength),
      );
      post({ type: "input-ack" });
      return;
    case "clear-output":
      peer.clearOutputAudio();
      outputGeneration = message.generation;
      output.clear();
      directOutput?.clear();
      return;
    case "audio-ack":
      outputInFlight = false;
      flushOutput();
      return;
    case "rtp-ack":
      rtpInFlight = false;
      return;
    case "media-error-ack":
      mediaErrorInFlight = false;
      return;
    case "offer":
    case "answer": {
      const task = message.type === "offer" ? peer.createOffer() : peer.applyAnswer(message.sdp);
      void task.then(
        (value) => {
          if (!stopped) {
            post({ type: "result", id: message.id, value: value ?? "" });
          }
        },
        (error: unknown) => {
          if (!stopped) {
            post({
              type: "request-error",
              id: message.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    }
  }
});

void OpenAIQuicksilverAudioPeer.create({
  iceServers: options.iceServers,
  signal: controller.signal,
  callbacks: {
    onAudio(audio) {
      if (stopped) {
        return;
      }
      if (directOutput) {
        directOutput.sendAudio(audio);
        return;
      }
      // A stalled parent cannot turn MessagePort into an unbounded audio queue.
      // Keep only the existing five-second newest tail and one in-flight batch.
      output.append(audio);
      flushOutput();
    },
    onRtpPacket() {
      if (stopped || rtpInFlight) {
        return;
      }
      rtpInFlight = true;
      post({ type: "rtp" });
    },
    ...(options.reportMediaErrors
      ? {
          onMediaError(error: Error) {
            if (stopped || mediaErrorInFlight) {
              return;
            }
            mediaErrorInFlight = true;
            post({ type: "media-error", message: error.message });
          },
        }
      : {}),
    onError: fail,
  },
}).then((created) => {
  if (stopped) {
    created.close();
    return;
  }
  peer = created;
  post({ type: "ready" });
}, fail);
