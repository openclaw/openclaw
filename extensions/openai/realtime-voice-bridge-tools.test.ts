// Openai tests cover realtime voice provider plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: mocks.execFileSyncMock };
});

vi.mock("ws", () => ({ default: mocks.FakeWebSocket }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

// mock-isolation: Tool transport tests supply synthetic credentials and do not exercise host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  isProviderAuthProfileConfiguredAsync: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  emitServerEvent,
  emitCompletedToolCalls,
  emitFunctionOutputAdded,
  expectedFunctionOutput,
  connectReadyBridge,
  expectedResponseCreateEvent,
  hasSentEventType,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

type Socket = Awaited<ReturnType<typeof connectReadyBridge>>;
type Bridge = ReturnType<typeof createNativeBridge>;
const sentOfType = (socket: Socket, type: string) =>
  parseSent(socket).filter((event) => event.type === type);
const outputsForCall = (socket: Socket, callId: string) =>
  sentOfType(socket, "conversation.item.create").filter(
    (event) => (event.item as { call_id?: string } | undefined)?.call_id === callId,
  );
const toolItem = (overrides: Record<string, unknown> = {}) => ({
  id: "item_tool_1",
  type: "function_call",
  status: "completed",
  call_id: "call_1",
  name: "lookup_weather",
  arguments: "{}",
  ...overrides,
});
const completedResponse = (output: unknown[]) => ({
  type: "response.done",
  response: { id: "response_1", status: "completed", output },
});
const numberedCalls = (length: number) =>
  Array.from({ length }, (_, index) => toolItem({ id: `item_${index}`, call_id: `call_${index}` }));
const submitWorkingResult = (bridge: Bridge) =>
  bridge.submitToolResult("call_1", { status: "working" }, { willContinue: true });
const submitDeliveredResult = (bridge: Bridge, callId = "call_1") =>
  bridge.submitToolResult(callId, { status: "already_delivered" }, { suppressResponse: true });
async function connectToolBridge({
  onToolCall = vi.fn(),
  ...overrides
}: Parameters<typeof createNativeBridge>[0] = {}) {
  const bridge = createNativeBridge({ onToolCall, ...overrides });
  return { bridge, socket: await connectReadyBridge(bridge), onToolCall };
}

describe("OpenAI realtime voice bridge tools", () => {
  beforeEach(resetTestState);
  afterEach(restoreTestEnvironment);

  it("executes tool calls only from successful response output", async () => {
    const { socket, onToolCall } = await connectToolBridge();

    emitServerEvent(socket, {
      type: "response.function_call_arguments.delta",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      delta: '{"question":"provisional',
    });
    emitServerEvent(socket, {
      type: "response.function_call_arguments.done",
      item_id: "item_tool_1",
      name: "openclaw_agent_consult",
      call_id: "call_1",
      arguments: '{"question":"still provisional"}',
    });
    emitServerEvent(socket, {
      type: "conversation.item.done",
      item: {
        id: "item_tool_1",
        type: "function_call",
        name: "openclaw_agent_consult",
        call_id: "call_1",
        arguments: '{"question":"not terminal"}',
      },
    });
    expect(onToolCall).not.toHaveBeenCalled();

    const completed = completedResponse([
      toolItem({ name: "openclaw_agent_consult", arguments: '{"question":"delegate this"}' }),
    ]);
    emitServerEvent(socket, completed);
    emitServerEvent(socket, completed);

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "openclaw_agent_consult",
      args: { question: "delegate this" },
    });
  });

  it("ignores malformed and unfinished response output items", async () => {
    const { socket, onToolCall } = await connectToolBridge();

    emitServerEvent(
      socket,
      completedResponse([
        null,
        "invalid",
        toolItem({
          status: "incomplete",
          name: "openclaw_agent_consult",
          arguments: '{"question":"unfinished"}',
        }),
      ]),
    );

    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("uses terminal response arguments for the shipped empty argument contract", async () => {
    const { socket, onToolCall } = await connectToolBridge();

    emitServerEvent(socket, completedResponse([toolItem({ arguments: "" })]));

    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item_tool_1",
      callId: "call_1",
      name: "lookup_weather",
      args: {},
    });
  });

  it.each([
    { name: "malformed JSON", arguments: '{"city":', reason: "malformed-json" },
    { name: "JSON null", arguments: "null", reason: "non-object-json" },
    { name: "non-string arguments", arguments: { city: "Paris" }, reason: "invalid-json-type" },
  ])("rejects $name per call without ending the session", async ({ arguments: args, reason }) => {
    const onError = vi.fn();
    const onEvent = vi.fn();
    const { socket, onToolCall } = await connectToolBridge({ onError, onEvent });
    const completed = completedResponse([toolItem({ arguments: args })]);

    emitServerEvent(socket, { type: "response.created", response: { id: "response_1" } });
    emitServerEvent(socket, completed);
    emitServerEvent(socket, completed);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${reason}`,
      itemId: "item_tool_1",
    });
    expect(outputsForCall(socket, "call_1")).toHaveLength(1);
  });

  it("rejects 256001-byte multibyte UTF-8 arguments", async () => {
    const onError = vi.fn();
    const { socket, onToolCall } = await connectToolBridge({ onError });
    const rawArgs = `{"x":"${"é".repeat(127_996)}a"}`;
    expect(Buffer.byteLength(rawArgs, "utf8")).toBe(256_001);

    emitServerEvent(socket, completedResponse([toolItem({ arguments: rawArgs })]));

    expect(onToolCall).toHaveBeenCalledTimes(0);
    expect(outputsForCall(socket, "call_1")).not.toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ends an extreme session before terminal tool-call ids become unbounded", async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const { bridge, socket, onToolCall } = await connectToolBridge({ onError, onClose });

    emitServerEvent(socket, completedResponse(numberedCalls(1_025)));

    expect(onToolCall).toHaveBeenCalledTimes(1_024);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      new Error("OpenAI realtime tool-call session limit exceeded (1024)"),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI realtime tool-call session limit exceeded (1024)",
    );
  });

  it("stops dispatching terminal output when a tool callback closes the bridge", async () => {
    const onToolCall = vi.fn();
    const bridge = createNativeBridge({ onToolCall });
    onToolCall.mockImplementation(() => bridge.close());
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, completedResponse(numberedCalls(2)));

    expect(onToolCall).toHaveBeenCalledTimes(1);
  });

  it("rejects undefined tool results without consuming a retryable call", async () => {
    const { bridge, socket } = await connectToolBridge();
    emitCompletedToolCalls(socket);
    const previousEventCount = socket.sent.length;

    expect(() => bridge.submitToolResult("call_1", undefined)).toThrow();
    expect(socket.sent).toHaveLength(previousEventCount);
    expect(hasSentEventType(socket, "response.create")).toBe(false);

    await bridge.submitToolResult("call_1", { recovered: true });

    expect(parseSent(socket).find((event) => event.type === "conversation.item.create")).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify({ recovered: true }),
      },
    });
  });

  it("does not request a realtime response for continuing tool results", async () => {
    const onEvent = vi.fn();
    const { bridge, socket } = await connectToolBridge({ onEvent });
    emitCompletedToolCalls(socket);

    const working = submitWorkingResult(bridge);

    expect(parseSent(socket).slice(-1)).toEqual([
      expectedFunctionOutput("call_1", { status: "working" }),
    ]);
    expect(hasSentEventType(socket, "response.create")).toBe(false);
    expect(working).toBeUndefined();

    const done = bridge.submitToolResult("call_1", { text: "done" });
    expect(done).toBeUndefined();

    expect(parseSent(socket).slice(-3)).toEqual([
      expectedFunctionOutput("call_1", { text: "done" }),
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
    ]);
    expect(sentOfType(socket, "response.create")).toHaveLength(1);
    emitFunctionOutputAdded(socket, "call_1");
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.added",
      detail: "itemType=function_call_output",
    });
    emitServerEvent(socket, {
      type: "conversation.item.done",
      item: { type: "function_call_output", call_id: "call_1" },
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.done",
      detail: "itemType=function_call_output",
    });
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_2" } });
    emitServerEvent(socket, { type: "response.done" });

    expect(sentOfType(socket, "response.create")).toHaveLength(1);
  });

  it("does not request a realtime response for suppressed tool results", async () => {
    const { bridge, socket } = await connectToolBridge();
    emitCompletedToolCalls(socket);

    const submission = submitDeliveredResult(bridge);

    expect(parseSent(socket).slice(-1)).toEqual([
      expectedFunctionOutput("call_1", { status: "already_delivered" }),
    ]);
    emitFunctionOutputAdded(socket, "call_1");
    await submission;
    expect(hasSentEventType(socket, "response.create")).toBe(false);
  });

  it("waits for every parallel tool result before continuing the response", async () => {
    const { bridge, socket } = await connectToolBridge();
    emitCompletedToolCalls(socket, ["call_1", "call_2"]);

    const first = bridge.submitToolResult("call_1", { text: "first" });
    emitFunctionOutputAdded(socket, "call_1");
    await first;

    expect(sentOfType(socket, "response.create")).toEqual([]);

    const second = bridge.submitToolResult("call_2", { text: "second" });
    emitFunctionOutputAdded(socket, "call_2");
    await second;

    expect(sentOfType(socket, "conversation.item.create")).toHaveLength(2);
    expect(sentOfType(socket, "response.create")).toHaveLength(1);
  });

  it("releases a deferred continuation when the last parallel result is suppressed", async () => {
    const { bridge, socket } = await connectToolBridge();
    emitCompletedToolCalls(socket, ["call_1", "call_2"]);

    const first = bridge.submitToolResult("call_1", { text: "first" });
    const second = submitDeliveredResult(bridge, "call_2");
    emitFunctionOutputAdded(socket, "call_1");
    emitFunctionOutputAdded(socket, "call_2");
    await Promise.all([first, second]);

    expect(sentOfType(socket, "response.create")).toHaveLength(1);
  });

  it("does not flush deferred response.create while a tool result is still continuing", async () => {
    const onError = vi.fn();
    const { bridge, socket } = await connectToolBridge({ onError });

    emitCompletedToolCalls(socket);
    const working = submitWorkingResult(bridge);
    emitFunctionOutputAdded(socket, "call_1");
    await working;
    bridge.sendUserMessage?.("queue after tool result");

    expect(onError).not.toHaveBeenCalled();
    expect(sentOfType(socket, "response.create")).toHaveLength(1);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_status" } });
    emitServerEvent(socket, {
      type: "response.done",
      response: { id: "resp_status", status: "completed", output: [] },
    });

    const done = bridge.submitToolResult("call_1", { text: "done" });
    emitFunctionOutputAdded(socket, "call_1");
    await done;

    expect(parseSent(socket).slice(-3)).toEqual([
      expectedFunctionOutput("call_1", { text: "done" }),
      expect.objectContaining({ type: "session.update" }),
      expectedResponseCreateEvent(),
    ]);
  });
});
