import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import {
  assertElevenLabsDialogueVoices,
  buildElevenLabsDialogueWebSocketUrl,
  isElevenLabsDialogueModel,
  resetElevenLabsDialogueSessionsForTests,
  setElevenLabsDialoguePoolLimitForTests,
  setElevenLabsDialogueSocketFactoryForTests,
  streamElevenLabsDialogue,
  synthesizeElevenLabsDialogue,
  type ElevenLabsDialogueRequest,
  type ElevenLabsDialogueSocket,
} from "./dialogue.js";

const VOICE_ID = "pMsXgVXv3BLzUgSXRplE";
const API_KEY = "xi-test-key";
const AUDIO = "AQID";

const baseRequest: ElevenLabsDialogueRequest = {
  text: "Hello from the bridge.",
  apiKey: API_KEY,
  voiceId: VOICE_ID,
  modelId: "eleven_v4_turbo",
  outputFormat: "pcm_22050",
  timeoutMs: 5_000,
  voiceSettings: { stability: 0.4 },
};

class ScriptedSocket implements ElevenLabsDialogueSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private openListeners: Array<() => void> = [];
  private messageListeners: Array<(data: unknown) => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];
  private closeListeners: Array<() => void> = [];
  private opened = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  open(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    this.readyState = 1;
    for (const listener of this.openListeners) {
      listener();
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    for (const listener of [...this.closeListeners]) {
      listener();
    }
  }

  fail(error: Error): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
    this.close();
  }

  emit(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener(data);
    }
  }

  push(message: unknown): void {
    this.emit(JSON.stringify(message));
  }

  onOpen(listener: () => void): void {
    this.openListeners.push(listener);
    if (this.opened) {
      listener();
    }
  }

  onMessage(listener: (data: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
}

function useSockets(): ScriptedSocket[] {
  const sockets: ScriptedSocket[] = [];
  setElevenLabsDialogueSocketFactoryForTests((url, options) => {
    const socket = new ScriptedSocket(url, options.headers);
    sockets.push(socket);
    return socket;
  });
  return sockets;
}

async function flush(): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    await Promise.resolve();
  }
}

function parsed(socket: ScriptedSocket): unknown[] {
  return socket.sent.map((frame) => JSON.parse(frame) as unknown);
}

async function openAndCollect(socket: ScriptedSocket): Promise<void> {
  await flush();
  socket.open();
  await flush();
}

afterEach(() => {
  resetElevenLabsDialogueSessionsForTests();
  vi.useRealTimers();
});

describe("ElevenLabs dialogue models", () => {
  it("routes v4 and conversational models to the dialogue websocket", () => {
    expect(isElevenLabsDialogueModel("eleven_v4")).toBe(true);
    expect(isElevenLabsDialogueModel(" Eleven_V4_Turbo ")).toBe(true);
    expect(isElevenLabsDialogueModel("eleven_v3_conversational")).toBe(true);
    expect(isElevenLabsDialogueModel("eleven_v3")).toBe(false);
    expect(isElevenLabsDialogueModel("eleven_flash_v2_5")).toBe(false);
    expect(isElevenLabsDialogueModel("eleven_turbo_v2_5")).toBe(false);
    expect(isElevenLabsDialogueModel(undefined)).toBe(false);
  });

  it("limits registered voices by model", () => {
    expect(() =>
      assertElevenLabsDialogueVoices("eleven_v4_turbo", [VOICE_ID, `${VOICE_ID}a`]),
    ).toThrow(/one voice/);
    expect(() => assertElevenLabsDialogueVoices("eleven_v3_conversational", [])).toThrow(
      /requires a voice id/,
    );
    const voices = Array.from(
      { length: 10 },
      (_unused, index) => `${VOICE_ID.slice(0, 19)}${index}`,
    );
    expect(() => assertElevenLabsDialogueVoices("eleven_v4", voices)).not.toThrow();
    expect(() => assertElevenLabsDialogueVoices("eleven_v4", [...voices, `${VOICE_ID}z`])).toThrow(
      /at most 10/,
    );
    expect(() => assertElevenLabsDialogueVoices("eleven_flash_v2_5", [VOICE_ID])).toThrow(
      /does not use the dialogue WebSocket/,
    );
  });

  it("builds a dialogue websocket url without the api key or latency query", () => {
    const url = new URL(
      buildElevenLabsDialogueWebSocketUrl({
        baseUrl: "https://api.elevenlabs.io",
        modelId: "eleven_v4",
        outputFormat: "pcm_22050",
        languageCode: "en",
        seed: 11,
        applyTextNormalization: "off",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/text-to-dialogue/stream-input");
    expect(url.searchParams.get("model_id")).toBe("eleven_v4");
    expect(url.searchParams.get("output_format")).toBe("pcm_22050");
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.get("seed")).toBe("11");
    expect(url.searchParams.get("apply_text_normalization")).toBe("off");
    expect(url.searchParams.has("optimize_streaming_latency")).toBe(false);
    expect(url.search).not.toContain(API_KEY);
  });

  it("rejects an unsupported base url scheme", () => {
    expect(() =>
      buildElevenLabsDialogueWebSocketUrl({
        baseUrl: "ftp://example.com",
        modelId: "eleven_v4_turbo",
      }),
    ).toThrow(/unsupported scheme/);
  });
});

describe("ElevenLabs dialogue turns", () => {
  it("registers one voice, flushes the turn, and closes a one-shot socket", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      modelId: "Eleven_V4_Turbo",
      voiceSettings: { stability: 0.2, similarityBoost: 0.9 } as { stability: number },
      languageCode: "en",
      seed: 4,
      applyTextNormalization: "auto",
    });
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    expect(socket.headers["xi-api-key"]).toBe(API_KEY);
    expect(new URL(socket.url).searchParams.get("model_id")).toBe("eleven_v4_turbo");
    expect(new URL(socket.url).search).not.toContain(API_KEY);
    expect(parsed(socket)).toEqual([
      { voices: [VOICE_ID], voice_settings: { stability: 0.2 } },
      {
        inputs: [{ text: baseRequest.text, voice_id: VOICE_ID, new_turn: true }],
        flush: true,
      },
    ]);
    socket.push({ audio: AUDIO });
    socket.push({ audio: "BAU=", is_final_audio_for_turn: true });
    await expect(pending).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(socket.readyState).toBe(3);
  });

  it("accepts audio and the turn boundary in one frame", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue(baseRequest);
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    socket.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await expect(pending).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("omits voice settings when stability is unset or out of range", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      voiceSettings: { stability: 2 },
    });
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    expect(parsed(socket)[0]).toEqual({ voices: [VOICE_ID] });
    socket.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await pending;
  });

  it("includes a stability of zero", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      voiceSettings: { stability: 0 },
    });
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    expect(parsed(socket)[0]).toEqual({ voices: [VOICE_ID], voice_settings: { stability: 0 } });
    socket.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await pending;
  });

  it("does not open a socket for invalid input", async () => {
    const sockets = useSockets();
    await expect(
      synthesizeElevenLabsDialogue({ ...baseRequest, modelId: "eleven_v3" }),
    ).rejects.toThrow(/does not use the dialogue WebSocket/);
    await expect(synthesizeElevenLabsDialogue({ ...baseRequest, text: "   " })).rejects.toThrow(
      /requires text/,
    );
    await expect(
      synthesizeElevenLabsDialogue({ ...baseRequest, voiceId: "too-short" }),
    ).rejects.toThrow(/Invalid voiceId/);
    await expect(synthesizeElevenLabsDialogue({ ...baseRequest, apiKey: "   " })).rejects.toThrow(
      /API key missing/,
    );
    await expect(
      synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "has spaces" }),
    ).rejects.toThrow(/conversation id/);
    await expect(
      synthesizeElevenLabsDialogue({ ...baseRequest, baseUrl: "ftp://example.com" }),
    ).rejects.toThrow(/unsupported scheme/);
    const controller = new AbortController();
    controller.abort(new Error("barge-in"));
    await expect(
      synthesizeElevenLabsDialogue({ ...baseRequest, signal: controller.signal }),
    ).rejects.toThrow("barge-in");
    expect(sockets).toHaveLength(0);
  });

  it("rejects a server error without putting the api key in the message", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue(baseRequest);
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    socket.push({ error: "unsupported_model", message: "nope", code: 1008 });
    await expect(pending).rejects.toThrow("ElevenLabs dialogue error (unsupported_model): nope");
    await expect(pending).rejects.toThrow(/nope/);
    try {
      await pending;
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain(API_KEY);
    }
  });

  it("rejects malformed server payloads", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue(baseRequest);
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    socket.emit("not-json");
    await expect(pending).rejects.toThrow(/non-JSON/);
  });

  it("rejects malformed audio and audio over the cap", async () => {
    const sockets = useSockets();
    const malformed = synthesizeElevenLabsDialogue(baseRequest);
    const first = sockets[0];
    if (!first) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(first);
    first.push({ audio: "****", is_final_audio_for_turn: true });
    await expect(malformed).rejects.toThrow(/malformed audio/);

    const oversized = synthesizeElevenLabsDialogue({ ...baseRequest, maxAudioBytes: 2 });
    const second = sockets[1];
    if (!second) {
      throw new Error("expected a second dialogue socket");
    }
    await openAndCollect(second);
    second.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await expect(oversized).rejects.toThrow(/exceeds 2 bytes/);
  });

  it("rejects an empty turn and a socket that closes before audio", async () => {
    const sockets = useSockets();
    const empty = synthesizeElevenLabsDialogue(baseRequest);
    const first = sockets[0];
    if (!first) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(first);
    first.push({ is_final_audio_for_turn: true });
    await expect(empty).rejects.toThrow(/produced no audio/);

    const closed = synthesizeElevenLabsDialogue(baseRequest);
    const second = sockets[1];
    if (!second) {
      throw new Error("expected a second dialogue socket");
    }
    await openAndCollect(second);
    second.close();
    await expect(closed).rejects.toThrow(/connection closed/);
  });

  it("rejects when the socket closes before it opens", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue(baseRequest);
    await flush();
    sockets[0]?.close();
    await expect(pending).rejects.toThrow(/closed before it was ready/);
  });

  it("rejects when the socket errors before it opens", async () => {
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue(baseRequest);
    await flush();
    sockets[0]?.fail(new Error("handshake failed"));
    await expect(pending).rejects.toThrow("handshake failed");
  });

  it("times out a turn that never finishes", async () => {
    vi.useFakeTimers();
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({ ...baseRequest, timeoutMs: 25 });
    await flush();
    sockets[0]?.open();
    await flush();
    const result = expect(pending).rejects.toThrow(/timed out after 25ms/);
    await vi.advanceTimersByTimeAsync(25);
    await result;
  });

  it("reuses one socket for a conversation and still starts a new turn", async () => {
    const sockets = useSockets();
    const first = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    const socket = sockets[0];
    if (!socket) {
      throw new Error("expected a dialogue socket");
    }
    await openAndCollect(socket);
    socket.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await expect(first).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(socket.readyState).toBe(1);

    const second = synthesizeElevenLabsDialogue({
      ...baseRequest,
      text: "Second line.",
      conversationId: "CA-1",
    });
    await flush();
    expect(sockets).toHaveLength(1);
    expect(parsed(socket).at(-1)).toEqual({
      inputs: [{ text: "Second line.", voice_id: VOICE_ID, new_turn: true }],
      flush: true,
    });
    expect(parsed(socket).filter((frame) => JSON.stringify(frame).includes("voices"))).toHaveLength(
      1,
    );
    socket.push({ audio: "BAU=", is_final_audio_for_turn: true });
    await expect(second).resolves.toEqual(Buffer.from([4, 5]));
  });

  it("opens a new socket when the call, voice, or api key changes", async () => {
    const sockets = useSockets();
    const first = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    await openAndCollect(sockets[0]!);
    sockets[0]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await first;

    const otherCall = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-2" });
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await flush();
    sockets[1]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await otherCall;

    const otherVoice = synthesizeElevenLabsDialogue({
      ...baseRequest,
      conversationId: "CA-1",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
    });
    await flush();
    expect(sockets).toHaveLength(3);
    sockets[2]?.open();
    await flush();
    sockets[2]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await otherVoice;

    const otherKey = synthesizeElevenLabsDialogue({
      ...baseRequest,
      conversationId: "CA-1",
      apiKey: "xi-other-key",
    });
    await flush();
    expect(sockets).toHaveLength(4);
    expect(sockets[3]?.headers["xi-api-key"]).toBe("xi-other-key");
    sockets[3]?.open();
    await flush();
    sockets[3]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await otherKey;
  });

  it("opens a fresh socket after the server ends the connection", async () => {
    const sockets = useSockets();
    const first = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    await openAndCollect(sockets[0]!);
    sockets[0]?.push({ audio: AUDIO, is_final: true });
    await expect(first).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(sockets[0]?.readyState).toBe(3);

    const second = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await flush();
    expect(parsed(sockets[1]!).some((frame) => JSON.stringify(frame).includes("voices"))).toBe(
      true,
    );
    sockets[1]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await second;
  });

  it("interrupts an in-flight turn by closing the socket and speaking the new one", async () => {
    const sockets = useSockets();
    const first = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    await openAndCollect(sockets[0]!);
    const second = synthesizeElevenLabsDialogue({
      ...baseRequest,
      text: "Barge.",
      conversationId: "CA-1",
    });
    const interrupted = expect(first).rejects.toThrow(/interrupted by a new turn/);
    await flush();
    expect(sockets[0]?.readyState).toBe(3);
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await flush();
    expect(parsed(sockets[1]!).at(-1)).toEqual({
      inputs: [{ text: "Barge.", voice_id: VOICE_ID, new_turn: true }],
      flush: true,
    });
    sockets[1]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await interrupted;
    await expect(second).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("closes the shared socket when synthesis is aborted", async () => {
    const sockets = useSockets();
    const controller = new AbortController();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      conversationId: "CA-1",
      signal: controller.signal,
    });
    await flush();
    await openAndCollect(sockets[0]!);
    controller.abort(new Error("barge-in"));
    await expect(pending).rejects.toThrow("barge-in");
    expect(sockets[0]?.readyState).toBe(3);

    const next = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await flush();
    sockets[1]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await next;
  });

  it("sends keep_alive on an idle conversation socket", async () => {
    vi.useFakeTimers();
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      conversationId: "CA-1",
      keepaliveMs: 15_000,
      sessionIdleMs: 60_000,
      timeoutMs: 60_000,
    });
    await flush();
    sockets[0]?.open();
    await flush();
    sockets[0]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await expect(pending).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(sockets[0]?.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sockets[0]?.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(parsed(sockets[0]!).at(-1)).toEqual({ keep_alive: true });
    expect(sockets[0]?.readyState).toBe(1);
  });

  it("does not keep a one-shot socket alive", async () => {
    vi.useFakeTimers();
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      keepaliveMs: 15_000,
      timeoutMs: 60_000,
    });
    await flush();
    sockets[0]?.open();
    await flush();
    sockets[0]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await pending;
    expect(sockets[0]?.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[0]?.sent).toHaveLength(2);
  });

  it("closes an idle conversation socket and opens a new one later", async () => {
    vi.useFakeTimers();
    const sockets = useSockets();
    const pending = synthesizeElevenLabsDialogue({
      ...baseRequest,
      conversationId: "CA-1",
      keepaliveMs: 60_000,
      sessionIdleMs: 1_000,
      timeoutMs: 60_000,
    });
    await flush();
    sockets[0]?.open();
    await flush();
    sockets[0]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await pending;
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets[0]?.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]?.readyState).toBe(3);

    const next = synthesizeElevenLabsDialogue({
      ...baseRequest,
      conversationId: "CA-1",
      keepaliveMs: 60_000,
      sessionIdleMs: 1_000,
      timeoutMs: 60_000,
    });
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await flush();
    sockets[1]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await next;
  });

  it("evicts the oldest conversation when the pool is full", async () => {
    setElevenLabsDialoguePoolLimitForTests(2);
    const sockets = useSockets();
    for (const conversationId of ["CA-1", "CA-2"]) {
      const pending = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId });
      await flush();
      const socket = sockets.at(-1);
      socket?.open();
      await flush();
      socket?.push({ audio: AUDIO, is_final_audio_for_turn: true });
      await pending;
    }
    const third = synthesizeElevenLabsDialogue({ ...baseRequest, conversationId: "CA-3" });
    await flush();
    expect(sockets[0]?.readyState).toBe(3);
    expect(sockets).toHaveLength(3);
    sockets[2]?.open();
    await flush();
    sockets[2]?.push({ audio: AUDIO, is_final_audio_for_turn: true });
    await third;
  });

  it("streams audio frames and closes the socket when released", async () => {
    const sockets = useSockets();
    const stream = await streamElevenLabsDialogue({ ...baseRequest, conversationId: "CA-1" });
    await flush();
    await openAndCollect(sockets[0]!);
    sockets[0]?.push({ audio: AUDIO });
    sockets[0]?.push({ is_final_audio_for_turn: true });
    const reader = stream.audioStream.getReader();
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: new Uint8Array([1, 2, 3]),
    });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(sockets[0]?.readyState).toBe(1);
    await stream.release();
    expect(sockets[0]?.readyState).toBe(3);
  });

  it("speaks a turn through a local dialogue websocket", async () => {
    resetElevenLabsDialogueSessionsForTests();
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const clients = new Set<WebSocket>();
    let seenUrl: URL | undefined;
    let seenKey: string | undefined;
    const messages: unknown[] = [];
    server.on("upgrade", (request, socket, head) => {
      seenUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const header = request.headers["xi-api-key"];
      seenKey = Array.isArray(header) ? header[0] : header;
      wss.handleUpgrade(request, socket, head, (ws) => {
        clients.add(ws);
        ws.on("close", () => {
          clients.delete(ws);
        });
        ws.on("message", (data) => {
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          messages.push(JSON.parse(text) as unknown);
          if (messages.length === 2) {
            ws.send(JSON.stringify({ audio: AUDIO }));
            ws.send(JSON.stringify({ is_final_audio_for_turn: true }));
          }
        });
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const audio = await synthesizeElevenLabsDialogue({
        ...baseRequest,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      expect(audio).toEqual(Buffer.from([1, 2, 3]));
      expect(seenUrl?.pathname).toBe("/v1/text-to-dialogue/stream-input");
      expect(seenUrl?.searchParams.get("model_id")).toBe("eleven_v4_turbo");
      expect(seenKey).toBe(API_KEY);
      expect(messages[0]).toEqual({ voices: [VOICE_ID], voice_settings: { stability: 0.4 } });
      expect(messages[1]).toEqual({
        inputs: [{ text: baseRequest.text, voice_id: VOICE_ID, new_turn: true }],
        flush: true,
      });
    } finally {
      for (const client of clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
