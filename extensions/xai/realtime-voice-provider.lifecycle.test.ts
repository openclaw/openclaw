import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket, isProviderAuthProfileConfiguredMock, resolveApiKeyForProviderMock } =
  await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));

vi.mock("./ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: isProviderAuthProfileConfiguredMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

import {
  createTestBridge,
  type FakeWebSocketInstance,
  openRealtimeBridge,
  parseSent,
} from "./realtime-voice-provider.test-support.js";

function inputTranscript(socket: FakeWebSocketInstance, transcript: string, itemId?: string) {
  socket.emitServer({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
}

function responseDone(socket: FakeWebSocketInstance, id: string, status = "completed") {
  socket.emitServer({ type: "response.done", response: { id, status } });
}

async function openTranscriptBridge() {
  const onTranscript = vi.fn();
  const bridge = createTestBridge({ onTranscript });
  return { bridge, socket: await openRealtimeBridge(bridge), onTranscript };
}

describe("xAI realtime response and transcript lifecycle", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    isProviderAuthProfileConfiguredMock.mockReset();
    isProviderAuthProfileConfiguredMock.mockReturnValue(false);
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    delete process.env.XAI_API_KEY;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("accepts successor audio when the cancelled response terminal arrives late", async () => {
    const onAudio = vi.fn();
    const onResponseDone = vi.fn();
    const bridge = createTestBridge({ onAudio, onResponseDone });
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "interrupted" } });
    bridge.handleBargeIn?.();
    socket.emitServer({ type: "response.created", response: { id: "successor" } });
    responseDone(socket, "interrupted", "cancelled");
    socket.emitServer({
      type: "response.output_audio.delta",
      response_id: "successor",
      delta: "AAA=",
    });
    expect(onAudio).toHaveBeenCalledOnce();
    expect(onResponseDone).not.toHaveBeenCalled();
    responseDone(socket, "successor");
    expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({
      responseId: "successor",
      status: "completed",
    });
    await bridge.close();
  });

  it("retires buffered tool calls from an interrupted response when a successor starts", async () => {
    const onToolCall = vi.fn();
    const bridge = createTestBridge({ onToolCall });
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "interrupted" } });
    socket.emitServer({
      type: "response.function_call_arguments.done",
      response_id: "interrupted",
      item_id: "item_interrupted",
      call_id: "call_interrupted",
      name: "lookup_weather",
      arguments: JSON.stringify({ city: "Paris" }),
    });
    bridge.handleBargeIn?.();
    socket.emitServer({ type: "response.created", response: { id: "successor" } });
    responseDone(socket, "interrupted", "cancelled");
    socket.emitServer({
      type: "response.function_call_arguments.done",
      response_id: "successor",
      item_id: "item_successor",
      call_id: "call_successor",
      name: "lookup_weather",
      arguments: JSON.stringify({ city: "Tokyo" }),
    });
    responseDone(socket, "successor");
    expect(onToolCall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ callId: "call_successor", args: { city: "Tokyo" } }),
    );
    await bridge.close();
  });

  it("ignores a late cancellation error after a successor response starts", async () => {
    const bridge = createTestBridge();
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "interrupted" } });
    bridge.handleBargeIn?.();
    socket.emitServer({ type: "response.created", response: { id: "successor" } });
    bridge.sendUserMessage?.("queued while successor is active");
    const responseCreatesBeforeError = parseSent(socket).filter(
      (event) => event.type === "response.create",
    ).length;
    socket.emitServer({
      type: "error",
      error: { message: "Cancellation failed: no active response found" },
    });
    expect(parseSent(socket).filter((event) => event.type === "response.create")).toHaveLength(
      responseCreatesBeforeError,
    );
    responseDone(socket, "successor");
    await bridge.close();
  });

  it("fences unkeyed retired output and preserves the next consult response", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const onResponseDone = vi.fn();
    const onToolCall = vi.fn();
    const onEvent = vi.fn();
    const bridge = createTestBridge({
      onAudio,
      onTranscript,
      onResponseDone,
      onToolCall,
      onEvent,
    });
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "response.created", response: { id: "consult" } });
    responseDone(socket, "consult");
    onEvent.mockClear();
    socket.emitServer({
      type: "response.output_audio.delta",
      delta: "AAA=",
    });
    socket.emitServer({
      type: "response.output_audio_transcript.done",
      transcript: "late",
    });
    expect(onAudio).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();

    socket.emitServer({ type: "response.created", response: { id: "continuation" } });
    socket.emitServer({
      type: "response.output_audio_transcript.delta",
      response_id: "continuation",
      delta: "current",
    });
    socket.emitServer({
      type: "response.done",
      response: {
        id: "consult",
        status: "completed",
        output: [
          {
            id: "stale-tool",
            type: "function_call",
            call_id: "stale-call",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
    });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onResponseDone).toHaveBeenCalledTimes(1);
    expect(onTranscript.mock.calls).toEqual([["assistant", "current", false]]);
    responseDone(socket, "continuation");
    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "current", false],
      ["assistant", "current", true],
    ]);
    expect(onResponseDone).toHaveBeenCalledTimes(2);
    await bridge.close();
  });

  it("previews snapshots immediately and retains corrections after audio starts", async () => {
    const { bridge, socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "response-1" } });
    inputTranscript(socket, "How", "user-1");
    expect(onTranscript).toHaveBeenLastCalledWith("user", "How", false, { textMode: "snapshot" });
    socket.emitServer({ type: "response.output_audio.delta", delta: "AAA=" });
    inputTranscript(socket, "How big is Earth?", "user-1");
    responseDone(socket, "response-1");
    inputTranscript(socket, "How big is Earth?", "user-1");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "How big is Earth?", true, { textMode: "snapshot" }],
    ]);
    await bridge.close();
  });

  it("ignores old response terminals while new speech is being recognized", async () => {
    const { bridge, socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "response.created", response: { id: "old" } });
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.output_audio_transcript.done", transcript: "old answer" });
    inputTranscript(socket, "How", "new-input");
    responseDone(socket, "old");
    expect(onTranscript.mock.calls.filter((call) => call[0] === "user" && call[2])).toEqual([]);
    socket.emitServer({ type: "response.created", response: { id: "new" } });
    inputTranscript(socket, "How big is Jupiter?", "new-input");
    responseDone(socket, "old", "cancelled");
    expect(onTranscript.mock.calls.filter((call) => call[0] === "user" && call[2])).toEqual([]);
    responseDone(socket, "new");
    expect(onTranscript).toHaveBeenLastCalledWith("user", "How big is Jupiter?", true, {
      textMode: "snapshot",
    });
    await bridge.close();
  });

  it("preserves distinct late input items and repeated words in separate utterances", async () => {
    const { bridge, socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    inputTranscript(socket, "Again", "late-A");
    inputTranscript(socket, "Again", "B");
    socket.emitServer({ type: "response.created", response: { id: "response-B" } });
    responseDone(socket, "response-B");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Again", true, { textMode: "snapshot" }],
      ["user", "Again", true, { textMode: "snapshot" }],
    ]);
    await bridge.close();
  });

  it("preserves the input when the response fails", async () => {
    const { bridge, socket, onTranscript } = await openTranscriptBridge();
    inputTranscript(socket, "Check the sensor");
    socket.emitServer({ type: "response.created", response: { id: "response-1" } });
    responseDone(socket, "response-1", "failed");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the sensor", true, { textMode: "snapshot" }],
    ]);
    await bridge.close();
    expect(onTranscript.mock.calls.filter((call) => call[2])).toHaveLength(1);
  });

  it("saves the question before the assistant final and previews post-response ASR", async () => {
    const { bridge, socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "response.created", response: { id: "one" } });
    inputTranscript(socket, "Question", "u1");
    socket.emitServer({
      type: "response.output_audio_transcript.done",
      response_id: "one",
      transcript: "Answer",
    });
    expect(
      onTranscript.mock.calls.filter((call) => call[2]).map((call) => call.slice(0, 3)),
    ).toEqual([
      ["user", "Question", true],
      ["assistant", "Answer", true],
    ]);
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "two" } });
    responseDone(socket, "two");
    inputTranscript(socket, "status", "u2");
    expect(onTranscript).toHaveBeenLastCalledWith("user", "status", false, {
      textMode: "snapshot",
    });
    await bridge.close();
    expect(onTranscript).toHaveBeenLastCalledWith("user", "status", true, {
      textMode: "snapshot",
    });
  });

  it("settles input recognized after the response finished once it stops changing", async () => {
    const { bridge, socket, onTranscript } = await openTranscriptBridge();
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "one" } });
    responseDone(socket, "one");
    vi.useFakeTimers();
    inputTranscript(socket, "Check the", "u1");
    vi.advanceTimersByTime(1_000);
    inputTranscript(socket, "Check the sensor", "u1");
    vi.advanceTimersByTime(1_000);
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the sensor", true, { textMode: "snapshot" }],
    ]);
    vi.useRealTimers();
    await bridge.close();
  });

  it("keeps a pending snapshot when a different input item fails transcription", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const bridge = createTestBridge({ onError, onTranscript });
    const socket = await openRealtimeBridge(bridge);
    socket.emitServer({ type: "input_audio_buffer.speech_started" });
    socket.emitServer({ type: "response.created", response: { id: "one" } });
    inputTranscript(socket, "Read the gauge", "b");
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "a",
      error: { message: "recognition failed" },
    });
    expect(onError).toHaveBeenCalledOnce();
    responseDone(socket, "one");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Read the gauge", true, { textMode: "snapshot" }],
    ]);
    await bridge.close();
  });
});
