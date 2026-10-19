import { describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackWorkspaceEvents } from "../events.js";

type Handler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createHarness(overrides?: {
  shouldDrop?: boolean;
  existingContext?: ReturnType<SlackMonitorContext["getSlackAssistantThreadContext"]>;
  replies?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
}) {
  const handlers: Record<string, Handler> = {};
  const state = {
    getSlackAssistantThreadContext: vi.fn(() => overrides?.existingContext),
    saveSlackAssistantThreadContext: vi.fn(),
    setSlackSuggestedPrompts: vi.fn(async () => true),
    trackEvent: vi.fn(),
  };
  const replies = overrides?.replies ?? vi.fn(async () => ({ messages: [] }));
  const update = overrides?.update ?? vi.fn(async () => ({}));
  const ctx = {
    app: {
      client: { conversations: { replies }, chat: { update } },
      event: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    },
    cfg: {},
    accountId: "default",
    runtime: { error: vi.fn() },
    botToken: "xoxb-test",
    botUserId: "B1",
    shouldDropMismatchedSlackEvent: () => overrides?.shouldDrop === true,
    ...state,
  } as unknown as SlackMonitorContext;
  registerSlackWorkspaceEvents({ ctx, trackEvent: state.trackEvent });
  return {
    emit: (event: Record<string, unknown>) => handlers[String(event.type)]?.({ event, body: {} }),
    ...state,
  };
}

const threadAddress = { channel_id: "D123", thread_ts: "1729999327.187299" };
const context = { channel_id: "C456", team_id: "T789", enterprise_id: "E123" };
const savedContext = {
  assistantChannelId: "D123",
  threadTs: "1729999327.187299",
  userId: "U123",
  channelId: "C456",
  teamId: "T789",
  enterpriseId: "E123",
};
const replyBlocks = [{ type: "section", text: { type: "mrkdwn", text: "assistant reply" } }];

function makeThreadEvent(type: string) {
  return { type, assistant_thread: { user_id: "U123", ...threadAddress, context: { ...context } } };
}

describe("Slack assistant events", () => {
  it("stores new assistant thread context and sets default prompts", async () => {
    const harness = createHarness();

    await harness.emit(makeThreadEvent("assistant_thread_started"));

    expect(harness.trackEvent).toHaveBeenCalledTimes(1);
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith(savedContext);
    expect(harness.setSlackSuggestedPrompts).toHaveBeenCalledWith({
      channelId: "D123",
      threadTs: "1729999327.187299",
      title: "Try asking",
      prompts: [
        { title: "What can you do?", message: "What can you help me with?" },
        {
          title: "Summarize this channel",
          message: "Summarize the recent activity in this channel.",
        },
        { title: "Draft a reply", message: "Help me draft a reply." },
      ],
    });
  });

  it("persists changed assistant thread context onto the first bot message", async () => {
    const botMessageTs = "1729999327.187299";
    const messages = [
      {
        user: "B1",
        ts: botMessageTs,
        text: "assistant reply",
        blocks: structuredClone(replyBlocks),
      },
      { user: "U123", ts: "1729999327.200000", text: "user asks" },
    ].toSorted((a, b) => Number(a.ts) - Number(b.ts));
    const replies = vi.fn(
      async ({ oldest, inclusive }: { oldest?: string; inclusive?: boolean }) => ({
        messages: messages.filter(
          (message) =>
            !oldest || Number(message.ts) > Number(oldest) || (message.ts === oldest && inclusive),
        ),
      }),
    );
    const update = vi.fn(async () => ({}));
    const harness = createHarness({ replies, update });

    await harness.emit(makeThreadEvent("assistant_thread_context_changed"));

    expect(update).toHaveBeenCalledWith({
      token: "xoxb-test",
      channel: "D123",
      ts: botMessageTs,
      text: "assistant reply",
      blocks: replyBlocks,
      metadata: { event_type: "assistant_thread_context", event_payload: context },
    });
    expect(harness.setSlackSuggestedPrompts).not.toHaveBeenCalled();
  });

  it("merges partial assistant thread context per field", async () => {
    const harness = createHarness();

    await harness.emit({
      type: "assistant_thread_context_changed",
      assistant_thread: { user_id: "U123", ...threadAddress, context: { team_id: "T_THREAD" } },
      context: { ...context, team_id: "T_EVENT" },
    });

    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      ...savedContext,
      teamId: "T_THREAD",
    });
  });

  it("preserves cached assistant thread context when updates omit optional fields", async () => {
    const cached = {
      ...savedContext,
      userId: "UOLD",
      channelId: "COLD",
      teamId: "TOLD",
      enterpriseId: "EOLD",
    };
    const harness = createHarness({ existingContext: { ...cached, updatedAt: 1 } });

    await harness.emit({
      type: "assistant_thread_context_changed",
      assistant_thread: threadAddress,
    });

    expect(harness.getSlackAssistantThreadContext).toHaveBeenCalledWith(
      "D123",
      "1729999327.187299",
    );
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith(cached);
  });

  it("drops mismatched workspace events before touching assistant state", async () => {
    const harness = createHarness({ shouldDrop: true });

    await harness.emit(makeThreadEvent("assistant_thread_started"));

    expect(harness.trackEvent).not.toHaveBeenCalled();
    expect(harness.saveSlackAssistantThreadContext).not.toHaveBeenCalled();
    expect(harness.setSlackSuggestedPrompts).not.toHaveBeenCalled();
  });
});
