import { EventEmitter } from "node:events";
import type { RealtimeVoiceAudioOutputPort } from "openclaw/plugin-sdk/realtime-voice";
import { OpenAIQuicksilverSocketRuntime } from "./realtime-quicksilver-socket.runtime.js";
import type {
  OpenAIQuicksilverSocketFactory,
  QuicksilverMediaSocket,
  QuicksilverMediaSocketFactory,
} from "./realtime-quicksilver-socket.shared.js";

/** Exercise the worker's real owner with deterministic fake wire I/O; production
 * always constructs a Worker. Real thread/network isolation has separate proof. */
export function fakeQuicksilverMediaSocket(
  createSocket: OpenAIQuicksilverSocketFactory,
): QuicksilverMediaSocketFactory {
  return (url, options, media, callbacks) => {
    const socket = createSocket(url, options);
    const events = new EventEmitter();
    let mediaStopped = false;
    const runtime = new OpenAIQuicksilverSocketRuntime(
      socket,
      media,
      (message) => {
        if (message.type === "input-ack" || message.type === "send-ack") {
          return;
        }
        try {
          if (message.type === "open") {
            events.emit("open");
          } else if (message.type === "frame") {
            events.emit("message", Buffer.from(message.data), message.isBinary);
          } else if (message.type === "audio" && !mediaStopped) {
            callbacks.onAudio(Buffer.from(message.audio));
          } else if (message.type === "error") {
            events.emit("error", new Error("GPT-Live media worker transport failed"));
          } else if (message.type === "close") {
            events.emit("close", message.code, Buffer.from(message.reason));
          }
        } finally {
          runtime.command({ type: "event-ack" });
        }
      },
      () => {},
      () => 0,
    );
    const adapter: QuicksilverMediaSocket = Object.assign(events, {
      get readyState() {
        return socket.readyState;
      },
      send(payload: string) {
        runtime.command({ type: "send", payload });
      },
      close(code = 1000, reason = "closed") {
        runtime.command({ type: "close", code, reason });
      },
      sendAudio(audio: Buffer) {
        runtime.command({ type: "audio", audio });
      },
      setAudioOutputPort(output: RealtimeVoiceAudioOutputPort) {
        runtime.command({ type: "audio-output", output });
      },
      startAudio() {
        runtime.command({ type: "start-audio" });
      },
      stopAudio() {
        mediaStopped = true;
        runtime.command({ type: "stop-audio" });
      },
    });
    // Object.assign copies getter values; keep socket state live for admission.
    Object.defineProperty(adapter, "readyState", { get: () => socket.readyState });
    return adapter;
  };
}

export function fakeQuicksilverSocketFactories(createSocket: OpenAIQuicksilverSocketFactory) {
  return {
    webSocketFactory: createSocket,
    mediaSocketFactory: fakeQuicksilverMediaSocket(createSocket),
  };
}
