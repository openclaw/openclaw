import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { realtimeVoiceSessionTesting } from "./realtime-voice-session.js";

describe("Codex app-server realtime voice bridge", () => {
  it("uses Realtime V3 on the bound thread and projects native media events", async () => {
    const requestRpc = vi.fn(async () => ({}));
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const onTranscript = vi.fn();
    const onEvent = vi.fn();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const request: RealtimeVoiceBridgeCreateRequest = {
      providerConfig: { voice: "verse" },
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      instructions: "Keep replies brief.",
      onAudio,
      onClearAudio,
      onTranscript,
      onEvent,
      onReady,
      onClose,
    };
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      request,
      new AbortController().signal,
    );

    await bridge.connect();
    bridge.sendAudio(Buffer.from([1, 0, 2, 0]));
    bridge.handleNotification({
      method: "thread/realtime/started",
      params: { threadId: "thread-1", version: "v3" },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/delta",
      params: { threadId: "thread-1", role: "assistant", delta: "Hi" },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "Hi there" },
    });
    bridge.handleNotification({
      method: "thread/realtime/outputAudio/delta",
      params: {
        threadId: "thread-1",
        audio: { data: Buffer.from([3, 4]).toString("base64"), sampleRate: 24_000 },
      },
    });
    bridge.handleNotification({
      method: "thread/realtime/itemAdded",
      params: { threadId: "thread-1", item: { type: "input_audio_buffer.speech_started" } },
    });

    expect(requestRpc).toHaveBeenNthCalledWith(
      1,
      "thread/realtime/start",
      {
        threadId: "thread-1",
        outputModality: "audio",
        transport: { type: "websocket" },
        version: "v3",
        includeStartupContext: true,
        initialItems: [{ role: "developer", text: "Keep replies brief." }],
        voice: "verse",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(requestRpc).toHaveBeenNthCalledWith(
      2,
      "thread/realtime/appendAudio",
      {
        threadId: "thread-1",
        audio: {
          data: Buffer.from([1, 0, 2, 0]).toString("base64"),
          sampleRate: 24_000,
          numChannels: 1,
          samplesPerChannel: 2,
        },
      },
      { signal: expect.any(AbortSignal), timeoutMs: 10_000 },
    );
    expect(onReady).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenNthCalledWith(1, "assistant", "Hi", false);
    expect(onTranscript).toHaveBeenNthCalledWith(2, "assistant", "Hi there", true);
    expect(onEvent).toHaveBeenCalledWith({ direction: "server", type: "response.done" });
    expect(onAudio).toHaveBeenCalledWith(Buffer.from([3, 4]));
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    bridge.handleNotification({
      method: "thread/realtime/closed",
      params: { threadId: "thread-1", reason: "remote" },
    });
    expect(await bridge.completion.promise).toBe("completed");
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("emits one portable response terminal for each completed native turn", async () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as CodexAppServerClient;
    const onEvent = vi.fn();
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {},
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onEvent,
      },
      new AbortController().signal,
    );
    await bridge.connect();

    for (const [user, assistant] of [
      ["first question", "first answer"],
      ["second question", "second answer"],
    ] as const) {
      bridge.handleNotification({
        method: "thread/realtime/transcript/done",
        params: { threadId: "thread-1", role: "user", text: user },
      });
      bridge.handleNotification({
        method: "thread/realtime/transcript/done",
        params: { threadId: "thread-1", role: "assistant", text: assistant },
      });
    }
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "user", text: "third question" },
    });
    bridge.handleNotification({
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-1", role: "assistant", text: "" },
    });

    expect(onEvent.mock.calls.filter(([event]) => event.type === "response.done")).toHaveLength(3);
  });

  it("keeps only one audio RPC in flight and fails closed when the bounded queue fills", async () => {
    let releaseAudio!: () => void;
    const stalledAudio = new Promise<void>((resolve) => {
      releaseAudio = resolve;
    });
    const requestRpc = vi.fn((method: string) =>
      method === "thread/realtime/appendAudio" ? stalledAudio : Promise.resolve({}),
    );
    const onError = vi.fn();
    const client = { request: requestRpc } as unknown as CodexAppServerClient;
    const bridge = realtimeVoiceSessionTesting.createBridge(
      client,
      "thread-1",
      {
        providerConfig: {},
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
        onError,
      },
      new AbortController().signal,
    );
    await bridge.connect();

    bridge.sendAudio(Buffer.alloc(4_800));
    for (let index = 0; index < 20; index += 1) {
      bridge.sendAudio(Buffer.alloc(4_800));
    }
    expect(
      requestRpc.mock.calls.filter(([method]) => method === "thread/realtime/appendAudio"),
    ).toHaveLength(1);

    bridge.sendAudio(Buffer.alloc(1));
    expect(await bridge.completion.promise).toBe("error");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Codex realtime voice input audio queue exceeded two seconds",
      }),
    );
    releaseAudio();
  });
});
