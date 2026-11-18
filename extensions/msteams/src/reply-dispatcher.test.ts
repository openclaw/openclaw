import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../runtime-api.js";
import { createStreamMock } from "./reply-dispatcher.test-support.js";

const createChannelMessageReplyPipelineMock = vi.hoisted(() => vi.fn());
const getMSTeamsRuntimeMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const renderMessagesMock = vi.hoisted(() =>
  vi.fn<(typeof import("./messenger.js"))["renderReplyPayloadsToMessages"]>(() => []),
);
const sendMessagesMock = vi.hoisted(() =>
  vi.fn<(typeof import("./messenger.js"))["sendMSTeamsMessages"]>(async () => []),
);

vi.mock("../runtime-api.js", () => ({
  createChannelMessageReplyPipeline: createChannelMessageReplyPipelineMock,
  logTypingFailure: vi.fn(),
  resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
}));

vi.mock("./runtime.js", () => ({
  getOptionalMSTeamsRuntime: () => null,
  getMSTeamsRuntime: getMSTeamsRuntimeMock,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("./messenger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messenger.js")>()),
  renderReplyPayloadsToMessages: renderMessagesMock,
  sendMSTeamsMessages: sendMessagesMock,
}));

import { createMSTeamsReplyDispatcher } from "./reply-dispatcher.js";

describe("createMSTeamsReplyDispatcher", () => {
  const typingCallbacks = {
    onReplyStart: vi.fn(async () => {}),
    onIdle: vi.fn(),
    onCleanup: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessagesMock.mockReset().mockResolvedValue([]);
    renderMessagesMock.mockReset().mockReturnValue([]);
    getGlobalHookRunnerMock.mockReturnValue(undefined);

    createChannelMessageReplyPipelineMock.mockReturnValue({
      onModelSelected: vi.fn(),
      typingCallbacks,
    });

    getMSTeamsRuntimeMock.mockReturnValue({
      system: {
        enqueueSystemEvent: enqueueSystemEventMock,
      },
      channel: {
        text: {
          chunkMarkdownTextWithMode: (text: string) => [text],
          resolveChunkMode: vi.fn(() => "length"),
          resolveMarkdownTableMode: vi.fn(() => "code"),
        },
        reply: { resolveHumanDelayConfig: vi.fn(() => undefined) },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createDispatcher(
    conversationType = "personal",
    msteamsConfig: Record<string, unknown> = {},
    onSentMessageIds?: (ids: string[]) => void,
  ) {
    const contextSendActivity = vi.fn(async () => ({ id: "activity-1" }));
    // Only personal chats support native streams.
    const streamMock = conversationType === "personal" ? createStreamMock() : undefined;
    const dispatcher = createMSTeamsReplyDispatcher({
      cfg: { channels: { msteams: msteamsConfig } },
      agentId: "agent",
      sessionKey: "agent:main:main",
      log: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
      app: { send: vi.fn(async () => ({})) } as never,
      conversationRef: {
        conversation: { id: "conv", conversationType },
        user: { id: "user" },
        agent: { id: "bot" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
      } as never,
      context: {
        sendActivity: contextSendActivity,
        ...(streamMock ? { stream: streamMock } : {}),
      } as never,
      replyStyle: "thread",
      textLimit: 4000,
      onSentMessageIds,
    });
    return {
      ...dispatcher,
      send: (payload: ReplyPayload) => dispatcher.delivery.deliver(payload, { kind: "final" }),
      sendActivity: contextSendActivity,
      stream: () => {
        if (!streamMock) {
          throw new Error("Only personal conversations have streams");
        }
        return streamMock;
      },
    };
  }

  type PipelineArgs = {
    typing?: {
      keepaliveIntervalMs?: number;
      maxDurationMs?: number;
      start?: () => Promise<void>;
    };
  };

  function pipelineArgs(): PipelineArgs {
    const [call] = createChannelMessageReplyPipelineMock.mock.calls;
    if (!call) {
      throw new Error("expected reply pipeline factory call");
    }
    return call[0] as PipelineArgs;
  }

  async function startTool(dispatcher: ReturnType<typeof createDispatcher>) {
    const event = { name: "exec", toolCallId: "exec-1", phase: "start" } as const;
    await dispatcher.replyOptions.onToolStart?.(event);
    await dispatcher.replyOptions.onItemEvent?.(projectAgentToolActivity(event));
  }

  async function toolResult(dispatcher: ReturnType<typeof createDispatcher>, isError: boolean) {
    await dispatcher.replyOptions.onItemEvent?.(
      projectAgentToolActivity({ toolCallId: "exec-1", name: "exec", phase: "result", isError }),
    );
  }

  function expectPartialFailure(
    result: Awaited<ReturnType<ReturnType<typeof createDispatcher>["send"]>>,
    content: string,
    messageIds: string[],
  ) {
    return expect(result?.finalization).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { visibleReplySent: true, messageIds, content },
    });
  }

  async function expectFinalization(
    result: Awaited<ReturnType<ReturnType<typeof createDispatcher>["send"]>>,
    content: string,
    messageIds: string[],
  ) {
    await expect(result?.finalization).resolves.toEqual({
      visibleReplySent: true,
      messageIds,
      content,
    });
  }

  it.each([false, true])("resolves authored fallback before delivery (table=%s)", async (table) => {
    const messenger = await vi.importActual<typeof import("./messenger.js")>("./messenger.js");
    renderMessagesMock.mockImplementation(messenger.renderReplyPayloadsToMessages);
    sendMessagesMock.mockResolvedValue(["reply-id"]);
    const dispatcher = createDispatcher(table ? "channel" : "personal", {
      streaming: { mode: "progress" },
    });
    const presentation: NonNullable<ReplyPayload["presentation"]> = {
      title: "Deployment",
      blocks: table
        ? [{ type: "table", caption: "Targets", headers: ["State"], rows: [["Ready"]] }]
        : [{ type: "buttons", buttons: [{ label: "Deploy", value: "deploy" }] }],
    };
    await dispatcher.send({
      text: "Authored fallback",
      presentation,
      presentationTextMode: "fallback",
    });
    await dispatcher.dispatcherOptions.onSettled?.();

    expect(sendMessagesMock.mock.calls.map(([send]) => send.messages)).toEqual([
      table
        ? [{ text: "Authored fallback" }]
        : [
            {
              adaptiveCard: expect.objectContaining({
                body: [
                  {
                    type: "TextBlock",
                    text: "Deployment",
                    weight: "Bolder",
                    size: "Medium",
                    wrap: true,
                  },
                ],
                actions: [
                  {
                    type: "Action.Submit",
                    title: "Deploy",
                    data: { value: "deploy", label: "Deploy" },
                  },
                ],
              }),
            },
          ],
    ]);
    if (!table) {
      expect(dispatcher.stream().emit).not.toHaveBeenCalled();
    }
  });

  it("sends an informative status update once work expands in personal chats", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: { mode: "progress", progress: { toolProgress: true } },
    });

    await dispatcher.dispatcherOptions.onReplyStart?.();
    expect(typingCallbacks.onReplyStart).toHaveBeenCalledTimes(1);
    const typing = pipelineArgs().typing;
    expect(typing?.keepaliveIntervalMs).toBeGreaterThan(3_000);
    expect(typing?.keepaliveIntervalMs).toBeLessThanOrEqual(10_000);
    expect(typing?.maxDurationMs).toBeGreaterThanOrEqual(300_000);
    await startTool(dispatcher);
    await vi.advanceTimersByTimeAsync(5_000);
    await dispatcher.replyOptions.onItemEvent?.({ progressText: "done" });

    const stream = dispatcher.stream();
    expect(stream.update).toHaveBeenCalled();
  });

  it("skips the typing keepalive in personal chats when typingIndicator=false", async () => {
    const dispatcher = createDispatcher("personal", { typingIndicator: false });

    await dispatcher.dispatcherOptions.onReplyStart?.();

    expect(typingCallbacks.onReplyStart).not.toHaveBeenCalled();
  });

  it("allows typing keepalive sends before any stream tokens arrive", async () => {
    const dispatcher = createDispatcher("personal");
    const sendTyping = pipelineArgs().typing?.start;
    expect(sendTyping).toBeTypeOf("function");

    const contextSendActivity = dispatcher.sendActivity;
    contextSendActivity.mockClear();
    await sendTyping?.();
    expect(contextSendActivity).toHaveBeenCalledWith({ type: "typing" });
  });

  it("suppresses typing keepalive after the user presses Stop", async () => {
    const dispatcher = createDispatcher("personal");
    const sendTyping = pipelineArgs().typing?.start;
    expect(sendTyping).toBeTypeOf("function");

    dispatcher.replyOptions.onPartialReply?.({ text: "first segment tokens" });
    const stream = dispatcher.stream();
    const contextSendActivity = dispatcher.sendActivity;
    contextSendActivity.mockClear();
    await sendTyping?.();
    expect(contextSendActivity).not.toHaveBeenCalled();

    stream.canceled = true;

    contextSendActivity.mockClear();
    await sendTyping?.();
    expect(contextSendActivity).not.toHaveBeenCalled();
  });

  it("keeps quiet Teams approvals visible without exposing tool failures", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: { mode: "progress", progress: { label: "Working" } },
    });
    const stream = dispatcher.stream();

    await startTool(dispatcher);
    expect(stream.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(stream.update).toHaveBeenLastCalledWith("Working");

    await dispatcher.replyOptions.onApprovalEvent?.({
      phase: "requested",
      approvalId: "approval-1",
      command: "confirm-operation",
    });
    expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("confirm-operation"));

    await toolResult(dispatcher, true);
    expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("confirm-operation"));
    expect(stream.update).toHaveBeenLastCalledWith(expect.not.stringContaining("exit 1"));
    expect(stream.update).toHaveBeenLastCalledWith(expect.not.stringContaining("Exec"));

    await dispatcher.replyOptions.onApprovalEvent?.({
      phase: "resolved",
      approvalId: "approval-1",
    });
    expect(stream.update).toHaveBeenLastCalledWith("Working");
    await toolResult(dispatcher, false);
    expect(stream.update).toHaveBeenLastCalledWith("Working");
  });

  it.each([
    { hook: "reply_payload_sending", mode: "partial", content: "final", id: "final-id" },
    { hook: "message_sending", mode: "progress", content: "final", id: "final-id" },
    { hook: undefined, mode: "block", content: "hello", id: "id-1" },
  ])("uses block delivery for mode=$mode with hook=$hook", async ({ hook, mode, content, id }) => {
    if (hook) {
      getGlobalHookRunnerMock.mockReturnValue({ hasHooks: (name: string) => name === hook });
    }
    renderMessagesMock.mockReturnValue([{ content }] as never);
    sendMessagesMock.mockResolvedValue([id]);
    const dispatcher = createDispatcher("personal", { streaming: { mode } });
    if (hook) {
      dispatcher.replyOptions.onPartialReply?.({ text: "original partial" });
      await startTool(dispatcher);
    }
    await dispatcher.send({ text: hook ? "authoritative final" : "block content" });
    if (hook) {
      await dispatcher.dispatcherOptions.onSettled?.();
      expect(dispatcher.replyOptions.onToolStart).toBeUndefined();
      expect(dispatcher.replyOptions.suppressDefaultToolProgressMessages).toBeUndefined();
      expect(dispatcher.stream().update).not.toHaveBeenCalled();
    } else {
      expect(dispatcher.replyOptions.disableBlockStreaming).toBe(false);
    }
    expect(dispatcher.replyOptions.onPartialReply).toBeUndefined();
    expect(dispatcher.stream().emit).not.toHaveBeenCalled();
    expect(sendMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("preserves acknowledged text when a media-only final has no logical text", async () => {
    renderMessagesMock.mockReturnValue([{ mediaUrl: "https://example.com/image.png" }] as never);
    sendMessagesMock.mockResolvedValue(["media-id"] as never);
    const dispatcher = createDispatcher("personal");
    const stream = dispatcher.stream();
    stream.close.mockResolvedValueOnce(undefined);

    dispatcher.replyOptions.onPartialReply?.({ text: "hello" });
    stream.acknowledge("hello");
    const result = await dispatcher.send({ mediaUrl: "https://example.com/image.png" });
    await dispatcher.dispatcherOptions.onSettled?.();

    await expectFinalization(result, "hello", ["stream-acknowledged", "media-id"]);
  });

  it("reports only accepted native and fallback content after partial fallback failure", async () => {
    renderMessagesMock.mockReturnValue([{ text: "world-one" }, { text: "world-two" }] as never);
    sendMessagesMock
      .mockResolvedValueOnce(["fallback-id"] as never)
      .mockRejectedValueOnce(new Error("fallback failed"));
    const dispatcher = createDispatcher("personal");
    const stream = dispatcher.stream();
    stream.close.mockRejectedValueOnce(new Error("close failed"));

    dispatcher.replyOptions.onPartialReply?.({ text: "hello" });
    stream.acknowledge("hello");
    const result = await dispatcher.send({ text: "hello world" });
    const finalization = expectPartialFailure(result, "hello\nworld-one", [
      "stream-acknowledged",
      "fallback-id",
    ]);
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;
  });

  it("keeps snapshot reasoning visible with toolProgress=false", async () => {
    vi.useFakeTimers();
    const dispatcher = createDispatcher("personal", {
      streaming: { mode: "progress", progress: { toolProgress: false, label: "Working" } },
    });

    const reasoning = (text: string) =>
      dispatcher.replyOptions.onReasoningStream?.({ text, isReasoningSnapshot: true });
    await reasoning("Checking");
    await vi.advanceTimersByTimeAsync(1_500);
    await reasoning("Checking files");

    const stream = dispatcher.stream();
    expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("Checking files"));
    const latest = String(stream.update.mock.calls.at(-1)?.[0]);
    expect(latest.match(/Checking/g)).toHaveLength(1);

    await dispatcher.replyOptions.onReasoningEnd?.();
    await reasoning("Next thought");
    expect(stream.update).toHaveBeenLastCalledWith(expect.stringContaining("Next thought"));
    expect(stream.update).toHaveBeenLastCalledWith(expect.not.stringContaining("Checking files"));

    await dispatcher.send({ text: "Final answer" });
    await dispatcher.dispatcherOptions.onSettled?.();
    const updateCount = stream.update.mock.calls.length;
    await reasoning("Late reasoning");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(stream.update).toHaveBeenCalledTimes(updateCount);
  });

  it("queues a system event when some queued Teams messages fail to send", async () => {
    const onSentMessageIds = vi.fn();
    renderMessagesMock.mockReturnValue([{ text: "one" }, { text: "two" }] as never);
    sendMessagesMock
      .mockResolvedValueOnce(["id-1"] as never)
      .mockRejectedValueOnce(Object.assign(new Error("gateway timeout"), { statusCode: 502 }));

    const dispatcher = createDispatcher(
      "personal",
      { streaming: { block: { enabled: false } } },
      onSentMessageIds,
    );

    const result = await dispatcher.send({ text: "block content" });
    const finalization = expectPartialFailure(result, "one", ["id-1"]);
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;

    expect(onSentMessageIds).toHaveBeenCalledWith(["id-1"]);
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [message, context] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(message).toContain("Microsoft Teams delivery failed");
    expect(message).toContain("the delivery outcome is unknown for 1 of 2 message blocks");
    expect(message).not.toContain("not delivered");
    expect(message).not.toContain("The user may not have received");
    expect(message).toContain("Error: gateway timeout.");
    expect(message).toContain("Delivery may already have succeeded");
    expect(message).not.toContain("Retrying later may succeed");
    expect(sendMessagesMock).toHaveBeenCalledTimes(2);
    expect(sendMessagesMock.mock.calls.map(([send]) => send.messages)).toEqual([
      [{ text: "one" }],
      [{ text: "two" }],
    ]);
    expect(context).toEqual({
      sessionKey: "agent:main:main",
      contextKey: "msteams:delivery-failure:conv",
    });
  });

  it.each([false, true])("settles queued sends with observerThrows=%s", async (observerThrows) => {
    renderMessagesMock.mockReturnValue([{ text: "hello" }] as never);
    sendMessagesMock.mockResolvedValue(["id-1"] as never);
    const onSentMessageIds = observerThrows
      ? () => {
          throw new Error("observer failed");
        }
      : undefined;
    const dispatcher = createDispatcher(
      "groupchat",
      {
        streaming: { block: { enabled: false } },
      },
      onSentMessageIds,
    );

    expect(dispatcher.delivery.observeMessageSent).toBe(true);
    const result = await dispatcher.send({ text: "hello" });
    let settled = false;
    void result?.finalization?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(sendMessagesMock).not.toHaveBeenCalled();

    await dispatcher.dispatcherOptions.onSettled?.();
    await expectFinalization(result, "hello", ["id-1"]);
  });

  it.each(["NO_REPLY", '{"text":"NO_REPLY"}', "No response is needed."])(
    "streams prepared literal text and settles its final: %s",
    async (text) => {
      const teams = createDispatcher("personal");
      const stream = teams.stream();
      teams.replyOptions.onPartialReply?.({ text });
      expect(stream.emit).toHaveBeenCalledWith(text);
      stream.acknowledge(text);
      const result = await teams.send({ text });
      await teams.dispatcherOptions.onSettled?.();
      await expect(result?.finalization).resolves.toMatchObject({
        visibleReplySent: true,
        content: text,
      });
    },
  );

  it("preserves both progress finals through real dispatcher settlement", async () => {
    renderMessagesMock.mockImplementation((payloads) =>
      payloads.flatMap((payload) => (payload.text ? [{ text: payload.text }] : [])),
    );
    sendMessagesMock.mockResolvedValue(["block-result"]);
    const teams = createDispatcher("personal", { streaming: { mode: "progress" } });
    const deliveries: Array<Awaited<ReturnType<typeof teams.delivery.deliver>>> = [];
    const events: string[] = [];
    const producer = createReplyDispatcher({
      deliver: async (payload, info) => {
        events.push(`deliver:${payload.text}`);
        const result = await teams.delivery.deliver(payload, info);
        deliveries.push(result);
        return result;
      },
      onIdle: async () => {
        events.push("settle");
        await teams.dispatcherOptions.onSettled?.();
      },
    });
    producer.sendFinalReply({ text: "First distinct result." });
    producer.sendFinalReply({ text: "# Second distinct result" });
    producer.markComplete();
    await producer.waitForIdle();
    const results = await Promise.all(
      deliveries.map((result) => Promise.resolve(result?.finalization ?? result)),
    );
    expect(events).toEqual([
      "deliver:First distinct result.",
      "deliver:# Second distinct result",
      "settle",
    ]);
    for (const text of ["First distinct result.", "Second distinct result"]) {
      expect(results).toContainEqual(
        expect.objectContaining({ visibleReplySent: true, content: expect.stringContaining(text) }),
      );
    }
  });

  it.each(["close", "fallback"])("joins an active native %s before later blocks", async (phase) => {
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const sent: string[] = [];
    renderMessagesMock.mockImplementation((payloads) =>
      payloads.flatMap((payload) => (payload.text ? [{ text: payload.text }] : [])),
    );
    sendMessagesMock.mockImplementation(async ({ messages }) => {
      const text = messages[0]?.text ?? "";
      if (phase === "fallback" && text === "First result") {
        started.resolve();
        await release.promise;
      }
      sent.push(text);
      return [`block-${text}`];
    });
    const teams = createDispatcher("personal", {
      streaming: { mode: "progress", block: { enabled: true } },
    });
    teams.stream().close.mockImplementation(async () => {
      if (phase === "fallback") {
        throw new Error("close failed");
      }
      started.resolve();
      await release.promise;
      sent.push("First result");
      return { id: "stream-final" };
    });
    const first = await teams.send({ text: "First result" });
    const settling = teams.dispatcherOptions.onSettled?.();
    await started.promise;
    const later = teams.send({ text: "Second result" });
    release.resolve();
    const second = await later;
    await settling;
    await teams.dispatcherOptions.onSettled?.();
    const results = await Promise.all([first?.finalization, second?.finalization]);
    expect(sent).toEqual(["First result", "Second result"]);
    expect(results).toEqual([
      expect.objectContaining({ visibleReplySent: true, content: "First result" }),
      expect.objectContaining({ visibleReplySent: true, content: "Second result" }),
    ]);
  });

  it("honors late Stop before later partial text and media", async () => {
    renderMessagesMock.mockImplementation((payloads) =>
      payloads.map(({ text, mediaUrl }) => ({ text, mediaUrl })),
    );
    sendMessagesMock.mockResolvedValue(["must-not-send"]);
    const teams = createDispatcher("personal", { streaming: { mode: "partial" } });
    const stream = teams.stream();
    teams.replyOptions.onPartialReply?.({ text: "First result" });
    const first = await teams.send({ text: "First result" });
    stream.acknowledge("First result");
    stream.close.mockImplementation(async () => {
      stream.canceled = true;
      return undefined;
    });
    const second = await teams.send({
      text: "Second result",
      mediaUrl: "https://example.test/later.png",
    });
    await teams.dispatcherOptions.onSettled?.();
    await expect(first?.finalization).resolves.toMatchObject({
      visibleReplySent: true,
      content: "First result",
    });
    expect(second).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    expect(sendMessagesMock).not.toHaveBeenCalled();
  });

  it("settles a stopped divergent final without media-before-text fallback", async () => {
    const payloads = [
      { mediaUrl: "https://example.test/must-not-send.png" },
      { text: "provider final" },
    ];
    renderMessagesMock.mockReturnValue([
      { mediaUrl: "https://example.test/must-not-send.png" },
    ] as never);
    const dispatcher = createDispatcher("personal");
    const stream = dispatcher.stream();
    stream.close.mockImplementation(async () => {
      stream.canceled = true;
      return undefined;
    });

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed preview" });
    stream.acknowledge("streamed preview");
    dispatcher.replyOptions.onPartialReply?.({ text: "provider final" });
    const results = [];
    for (const payload of payloads) {
      results.push(await dispatcher.send(payload));
    }
    await dispatcher.dispatcherOptions.onSettled?.();

    const nativeResult = results.find((result) => result?.finalization !== undefined);
    await expectFinalization(nativeResult, "streamed preview", ["stream-acknowledged"]);
    expect(stream.clearText).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(renderMessagesMock).not.toHaveBeenCalled();
    expect(sendMessagesMock).not.toHaveBeenCalled();
  });

  it("releases later payloads only after divergent native replacement settles", async () => {
    renderMessagesMock.mockReturnValue([{ text: "second payload" }] as never);
    sendMessagesMock.mockResolvedValue(["post-native-id"] as never);
    const dispatcher = createDispatcher("personal");
    const stream = dispatcher.stream();

    dispatcher.replyOptions.onPartialReply?.({ text: "streamed preview" });
    stream.acknowledge("streamed preview");
    dispatcher.replyOptions.onPartialReply?.({ text: "provider final" });
    const nativeResult = await dispatcher.send({ text: "provider final" });
    await dispatcher.send({ text: "second payload" });

    expect(sendMessagesMock).not.toHaveBeenCalled();
    await dispatcher.dispatcherOptions.onSettled?.();

    await expectFinalization(nativeResult, "provider final\nsecond payload", [
      "stream-final",
      "post-native-id",
    ]);
    expect(renderMessagesMock).toHaveBeenCalledWith(
      [{ text: "second payload" }],
      expect.any(Object),
    );
    expect(sendMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a never-dispatched queued failure for core event suppression", async () => {
    const failure = new PlatformMessageNotDispatchedError("local media load failed", {
      cause: new Error("missing file"),
    });
    renderMessagesMock.mockReturnValue([{ mediaUrl: "/missing/file" }] as never);
    sendMessagesMock.mockRejectedValue(failure);
    const dispatcher = createDispatcher("groupchat", {
      streaming: { block: { enabled: false } },
    });

    const result = await dispatcher.send({ text: "attachment" });
    const finalization = expect(result?.finalization).rejects.toBe(failure);
    await dispatcher.dispatcherOptions.onSettled?.();
    await finalization;
  });
});
