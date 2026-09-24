import {
  canonicalizeBase64,
  createRealtimeVoiceAudioPortSender,
  rawDataToString,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import type { RawData } from "ws";
import {
  OpenAIQuicksilverAudioAdapter,
  OpenAIQuicksilverAudioClock,
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { parseOpenAIQuicksilverEvent } from "./realtime-quicksilver-events.js";
import { buildOpenAIQuicksilverAudioAppend } from "./realtime-quicksilver-protocol.js";
import {
  type OpenAIQuicksilverSocket,
  QUICKSILVER_SOCKET_AUDIO_BYTES,
  QUICKSILVER_SOCKET_CONTROL_BYTES,
  QUICKSILVER_SOCKET_CONTROL_LIMIT,
  type QuicksilverSocketCommand,
  type QuicksilverSocketEvent,
  type QuicksilverSocketMediaOptions,
  type QuicksilverSocketMessage,
} from "./realtime-quicksilver-socket.shared.js";

/** Worker-only media owner. Admission and agent delegation never enter this module. */
export class OpenAIQuicksilverSocketRuntime {
  private readonly audio: OpenAIQuicksilverAudioAdapter;
  private readonly pending = new OpenAIQuicksilverPendingAudio();
  private output: ReturnType<typeof createRealtimeVoiceAudioPortSender> | undefined;
  private readonly clock = new OpenAIQuicksilverAudioClock(() => {
    const frame = Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
    this.pending.readInto(frame);
    this.sendPcm(frame);
  });
  private readonly events: QuicksilverSocketEvent[] = [];
  private eventInFlight = false;
  private controlBytes = 0;
  private controlCount = 0;
  private audioBytes = 0;
  private started = false;
  private mediaStopped = false;
  private failed = false;
  private closed = false;

  constructor(
    private readonly socket: OpenAIQuicksilverSocket,
    private readonly media: QuicksilverSocketMediaOptions,
    private readonly post: (event: QuicksilverSocketMessage) => void,
    private readonly dispose: () => void,
    private readonly bufferedAmount: () => number,
  ) {
    this.audio = new OpenAIQuicksilverAudioAdapter({
      audioFormat: media.audioFormat,
      onAudio: (audio) => this.enqueue({ type: "audio", audio }),
    });
    socket.once("open", () => this.enqueue({ type: "open" }));
    socket.on("message", (data, binary) => this.onFrame(data, binary));
    socket.on("error", () => this.fail());
    socket.on("close", (code, reason) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.stopAudio();
      this.enqueue({ type: "close", code: code ?? 1006, reason: reason?.toString("utf8") ?? "" });
    });
  }

  command(command: QuicksilverSocketCommand): void {
    if (command.type === "event-ack") {
      this.eventInFlight = false;
      this.flush();
      return;
    }
    if (command.type === "audio-output") {
      const output = createRealtimeVoiceAudioPortSender(command.output);
      if (this.mediaStopped || this.closed || this.failed || this.output) {
        output.close();
        return;
      }
      this.discardQueuedAudio();
      this.output = output;
      return;
    }
    if (command.type === "close") {
      this.stopAudio();
      this.socket.close(command.code, command.reason);
      return;
    }
    if (command.type === "stop-audio") {
      this.stopAudio();
      return;
    }
    if (command.type === "audio") {
      try {
        if (!this.mediaStopped && !this.closed && !this.failed) {
          const pcm = this.audio.decodeInput(
            Buffer.from(command.audio.buffer, command.audio.byteOffset, command.audio.byteLength),
          );
          if (this.media.paced || !this.started) {
            this.pending.append(pcm);
          } else {
            this.sendPcm(pcm);
          }
        }
      } finally {
        this.post({ type: "input-ack" });
      }
      return;
    }
    if (command.type === "send") {
      try {
        this.send(command.payload);
      } finally {
        this.post({ type: "send-ack" });
      }
      return;
    }
    if (this.mediaStopped || this.started || this.closed || this.failed) {
      return;
    }
    this.started = true;
    if (this.media.paced) {
      this.clock.start();
    } else if (this.pending.length) {
      const pcm = Buffer.alloc(this.pending.length);
      this.pending.readInto(pcm);
      this.sendPcm(pcm);
    }
  }

  private sendPcm(pcm: Buffer): void {
    if (pcm.length) {
      this.send(
        JSON.stringify(buildOpenAIQuicksilverAudioAppend(this.media.model, pcm.toString("base64"))),
      );
    }
  }

  private send(payload: string): void {
    if (this.closed || this.failed || this.socket.readyState !== 1) {
      return;
    }
    if (this.bufferedAmount() + Buffer.byteLength(payload) > QUICKSILVER_SOCKET_CONTROL_BYTES) {
      this.fail();
      return;
    }
    try {
      this.socket.send(payload);
    } catch {
      this.fail();
    }
  }

  private onFrame(data: RawData, isBinary: boolean): void {
    if (this.failed || this.closed) {
      return;
    }
    const payload = rawDataToString(data);
    const event = isBinary ? null : parseOpenAIQuicksilverEvent(payload, this.media.model);
    if (event?.kind === "audio") {
      if (this.mediaStopped) {
        return;
      }
      const canonical = canonicalizeBase64(event.data);
      if (!canonical) {
        this.fail();
        return;
      }
      const pcm = Buffer.from(canonical, "base64");
      // The direct sink is always PCM16/24kHz, independent of carrier encoding.
      if (this.output) {
        this.output.sendAudio(pcm);
      } else {
        this.audio.sendOutput(pcm);
      }
      return;
    }
    if (event?.kind === "audio-cleared") {
      this.output?.clear();
      this.discardQueuedAudio();
      this.audio.reset();
    }
    if (
      event?.kind === "transcript-done" &&
      event.role === "assistant" &&
      !this.mediaStopped &&
      !this.output
    ) {
      this.audio.finishOutput();
    }
    if (event?.kind === "session-closed") {
      this.stopAudio();
    }
    // Keep control-plane frames intact, including final transcripts and session.closed.
    // No PCM/base64 payload crosses back to the Gateway for parsing.
    const bytes = isBinary
      ? Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data)
      : Buffer.from(payload);
    this.enqueue({ type: "frame", data: bytes, isBinary });
  }

  private stopAudio(): void {
    this.mediaStopped = true;
    this.output?.close();
    this.clock.stop();
    this.pending.clear();
    this.discardQueuedAudio();
    this.audio.reset();
  }

  private discardQueuedAudio(): void {
    for (let index = this.events.length - 1; index >= 0; index--) {
      if (this.events[index]!.type === "audio") {
        this.events.splice(index, 1);
      }
    }
    this.audioBytes = 0;
  }

  private enqueue(incoming: QuicksilverSocketEvent): void {
    let event = incoming;
    if (event.type === "audio") {
      if (this.mediaStopped) {
        return;
      }
      if (event.audio.byteLength > QUICKSILVER_SOCKET_AUDIO_BYTES) {
        event = {
          type: "audio",
          audio: Buffer.from(event.audio.subarray(-QUICKSILVER_SOCKET_AUDIO_BYTES)),
        };
      }
      this.audioBytes += event.audio.byteLength;
      while (
        this.audioBytes > QUICKSILVER_SOCKET_AUDIO_BYTES ||
        this.events.length >= QUICKSILVER_SOCKET_CONTROL_LIMIT * 2
      ) {
        const index = this.events.findIndex((queued) => queued.type === "audio");
        if (index < 0) {
          break;
        }
        const removed = this.events.splice(index, 1)[0]!;
        if (removed.type === "audio") {
          this.audioBytes -= removed.audio.byteLength;
        }
      }
    } else {
      const bytes = event.type === "frame" ? event.data.byteLength : 0;
      if (
        event.type !== "error" &&
        event.type !== "close" &&
        (this.controlCount >= QUICKSILVER_SOCKET_CONTROL_LIMIT ||
          this.controlBytes + bytes > QUICKSILVER_SOCKET_CONTROL_BYTES)
      ) {
        this.fail();
        return;
      }
      this.controlBytes += bytes;
      this.controlCount++;
    }
    this.events.push(event);
    this.flush();
  }

  private flush(): void {
    if (this.eventInFlight) {
      return;
    }
    const event = this.events.shift();
    if (!event) {
      if (this.closed) {
        this.dispose();
      }
      return;
    }
    if (event.type === "audio") {
      this.audioBytes -= event.audio.byteLength;
    } else {
      this.controlCount--;
      if (event.type === "frame") {
        this.controlBytes -= event.data.byteLength;
      }
    }
    this.eventInFlight = true;
    this.post(event);
  }

  private fail(): void {
    if (this.failed || this.closed) {
      return;
    }
    this.failed = true;
    this.stopAudio();
    // Never clone a ws exception: its message can contain a URL or auth headers.
    try {
      this.enqueue({ type: "error" });
    } finally {
      this.socket.close(1011, "media transport failed");
    }
  }
}
