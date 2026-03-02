/**
 * Unit tests for OpenAI Realtime Conversation Provider
 *
 * Uses a mocked WebSocket (via vi.mock) to verify the provider sends the correct
 * events and fires the correct callbacks without any network I/O.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- mock WebSocket ---------------------------------------------------------

/**
 * Minimal fake WebSocket that behaves like the real `ws` WebSocket:
 * - Emits "open" asynchronously on construction
 * - Captures .send() calls
 * - Exposes helpers to trigger server-side events (message, close, error)
 */
class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  // Track the most recently created instance so tests can interact with it
  static lastInstance: FakeWebSocket | null = null;

  constructor(_url: string, _opts?: unknown) {
    super();
    FakeWebSocket.lastInstance = this;
    // Simulate async open
    setTimeout(() => this.emit("open"), 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", 1000, Buffer.from(""));
  }

  /** Simulate a message arriving from the server */
  simulateMessage(event: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  /** Simulate a server-initiated close */
  simulateClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code, Buffer.from(""));
  }
}

vi.mock("ws", () => ({
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

// ---- import after mock is in place ------------------------------------------

const { OpenAIRealtimeConversationProvider } = await import("./openai-realtime-conversation.js");
import type { RealtimeConversationSession } from "./openai-realtime-conversation.js";

// ---- helpers ----------------------------------------------------------------

/** Create a session and wait until it is connected. */
async function connectSession(opts?: {
  systemPrompt?: string;
  voice?: string;
  silenceDurationMs?: number;
  vadThreshold?: number;
}): Promise<RealtimeConversationSession> {
  const provider = new OpenAIRealtimeConversationProvider({
    apiKey: "test-key",
    model: "gpt-4o-realtime-preview",
    voice: opts?.voice ?? "alloy",
    systemPrompt: opts?.systemPrompt,
    silenceDurationMs: opts?.silenceDurationMs ?? 800,
    vadThreshold: opts?.vadThreshold ?? 0.5,
  });

  const session = provider.createSession();
  await session.connect();
  return session;
}

/** Parse the last N sent messages from the fake WS. */
function sentEvents(ws: FakeWebSocket): Array<Record<string, unknown>> {
  return ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

// ---- tests ------------------------------------------------------------------

describe("OpenAIRealtimeConversationProvider", () => {
  it("throws when apiKey is missing", () => {
    expect(() => new OpenAIRealtimeConversationProvider({ apiKey: "" })).toThrow(
      "OpenAI API key required",
    );
  });

  it("returns name = openai-realtime-conversation", () => {
    const provider = new OpenAIRealtimeConversationProvider({ apiKey: "k" });
    expect(provider.name).toBe("openai-realtime-conversation");
  });

  it("creates a session that starts disconnected", () => {
    const provider = new OpenAIRealtimeConversationProvider({ apiKey: "k" });
    const session = provider.createSession();
    expect(session.isConnected()).toBe(false);
  });
});

describe("OpenAIRealtimeConversationSession", () => {
  beforeEach(() => {
    FakeWebSocket.lastInstance = null;
  });

  it("sends session.update on connect with correct parameters", async () => {
    const session = await connectSession({
      systemPrompt: "Be helpful",
      voice: "coral",
      silenceDurationMs: 600,
      vadThreshold: 0.3,
    });

    const ws = FakeWebSocket.lastInstance!;
    const events = sentEvents(ws);

    expect(events).toHaveLength(1);
    const su = events[0];
    expect(su.type).toBe("session.update");

    const s = su.session as Record<string, unknown>;
    expect(s.voice).toBe("coral");
    expect(s.input_audio_format).toBe("g711_ulaw");
    expect(s.output_audio_format).toBe("g711_ulaw");
    expect(s.modalities).toEqual(["text", "audio"]);
    expect(s.instructions).toBe("Be helpful");

    const td = s.turn_detection as Record<string, unknown>;
    expect(td.type).toBe("server_vad");
    expect(td.silence_duration_ms).toBe(600);
    expect(td.threshold).toBe(0.3);

    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("omits instructions when systemPrompt is not set", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;
    const su = sentEvents(ws)[0];
    const s = su.session as Record<string, unknown>;
    expect(s.instructions).toBeUndefined();
    session.close();
  });

  it("sendAudio sends input_audio_buffer.append with base64 payload", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;
    const before = ws.sent.length;

    const audio = Buffer.from([0x01, 0x02, 0x03]);
    session.sendAudio(audio);

    const events = sentEvents(ws).slice(before);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("input_audio_buffer.append");
    expect(events[0].audio).toBe(audio.toString("base64"));

    session.close();
  });

  it("does not send audio when disconnected", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    session.close();
    const before = ws.sent.length;

    session.sendAudio(Buffer.from([0xff]));
    expect(ws.sent.length).toBe(before);
  });

  it("sends response.cancel and fires onSpeechStart on speech_started", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    const speechStartCb = vi.fn();
    session.onSpeechStart(speechStartCb);

    const before = ws.sent.length;
    ws.simulateMessage({ type: "input_audio_buffer.speech_started" });
    await new Promise((r) => setTimeout(r, 0));

    const events = sentEvents(ws).slice(before);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.cancel");
    expect(speechStartCb).toHaveBeenCalledOnce();

    session.close();
  });

  it("fires onAudioDelta for response.audio.delta", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    const chunks: Buffer[] = [];
    session.onAudioDelta((chunk) => chunks.push(chunk));

    const payload = Buffer.from([0xaa, 0xbb]).toString("base64");
    ws.simulateMessage({ type: "response.audio.delta", delta: payload });
    await new Promise((r) => setTimeout(r, 0));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(Buffer.from(payload, "base64"));

    session.close();
  });

  it("accumulates and fires onTranscriptDelta/Done for caller transcript", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    const deltas: string[] = [];
    const dones: string[] = [];
    session.onTranscriptDelta((p) => deltas.push(p));
    session.onTranscriptDone((t) => dones.push(t));

    ws.simulateMessage({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Hel",
    });
    ws.simulateMessage({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "lo",
    });
    ws.simulateMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hello",
    });
    await new Promise((r) => setTimeout(r, 0));

    // delta accumulates: "Hel", then "Hello"
    expect(deltas).toEqual(["Hel", "Hello"]);
    expect(dones).toEqual(["Hello"]);

    session.close();
  });

  it("resets input transcript accumulator after done", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    const dones: string[] = [];
    session.onTranscriptDone((t) => dones.push(t));

    ws.simulateMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "First",
    });
    ws.simulateMessage({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Second",
    });
    ws.simulateMessage({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Second",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(dones).toEqual(["First", "Second"]);
    session.close();
  });

  it("fires onResponseTranscriptDelta/Done for AI transcript", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    const deltas: string[] = [];
    const dones: string[] = [];
    session.onResponseTranscriptDelta((p) => deltas.push(p));
    session.onResponseTranscriptDone((t) => dones.push(t));

    ws.simulateMessage({ type: "response.audio_transcript.delta", delta: "Hi " });
    ws.simulateMessage({ type: "response.audio_transcript.delta", delta: "there" });
    ws.simulateMessage({ type: "response.audio_transcript.done", transcript: "Hi there" });
    await new Promise((r) => setTimeout(r, 0));

    expect(deltas).toEqual(["Hi ", "Hi there"]);
    expect(dones).toEqual(["Hi there"]);

    session.close();
  });

  it("isConnected() returns false after close()", async () => {
    const session = await connectSession();
    expect(session.isConnected()).toBe(true);
    session.close();
    expect(session.isConnected()).toBe(false);
  });

  it("does not attempt reconnect after intentional close()", async () => {
    const session = await connectSession();
    const ws = FakeWebSocket.lastInstance!;

    session.close();
    const instanceBefore = FakeWebSocket.lastInstance;

    // Simulate server closing after we closed (would normally trigger reconnect if not intentional)
    ws.simulateClose(1006);
    await new Promise((r) => setTimeout(r, 50));

    // No new WebSocket should have been created
    expect(FakeWebSocket.lastInstance).toBe(instanceBefore);
  });
});
