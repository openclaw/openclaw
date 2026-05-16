import type { App } from "@slack/bolt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackAssistantEvents } from "./assistant.js";

type Handler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createHarness(overrides?: { shouldDrop?: boolean }) {
  const handlers: Record<string, Handler> = {};
  const saveSlackAssistantThreadContext = vi.fn();
  const setSlackAssistantSuggestedPrompts = vi.fn(async () => true);
  const trackEvent = vi.fn();
  const ctx = {
    app: {
      event: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as App,
    runtime: { error: vi.fn() },
    shouldDropMismatchedSlackEvent: () => overrides?.shouldDrop === true,
    saveSlackAssistantThreadContext,
    setSlackAssistantSuggestedPrompts,
  } as unknown as SlackMonitorContext;
  registerSlackAssistantEvents({ ctx, trackEvent });
  return {
    handlers,
    saveSlackAssistantThreadContext,
    setSlackAssistantSuggestedPrompts,
    trackEvent,
  };
}

function makeThreadEvent(type: string) {
  return {
    type,
    assistant_thread: {
      user_id: "U123",
      channel_id: "D123",
      thread_ts: "1729999327.187299",
      context: {
        channel_id: "C456",
        team_id: "T789",
        enterprise_id: "E123",
      },
    },
  };
}

function makeTopLevelContextThreadEvent(type: string) {
  return {
    type,
    assistant_thread: {
      user_id: "U123",
      channel_id: "D123",
      thread_ts: "1729999327.187299",
    },
    context: {
      channel_id: "C456",
      team_id: "T789",
      enterprise_id: "E123",
    },
  };
}

describe("registerSlackAssistantEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores new assistant thread context and sets default prompts", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_started?.({
      event: makeThreadEvent("assistant_thread_started"),
      body: {},
    });

    expect(harness.trackEvent).toHaveBeenCalledTimes(1);
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      assistantChannelId: "D123",
      threadTs: "1729999327.187299",
      userId: "U123",
      channelId: "C456",
      teamId: "T789",
      enterpriseId: "E123",
    });
    expect(harness.setSlackAssistantSuggestedPrompts).toHaveBeenCalledWith({
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

  it("updates assistant thread context without resetting prompts", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_context_changed?.({
      event: makeThreadEvent("assistant_thread_context_changed"),
      body: {},
    });

    expect(harness.trackEvent).toHaveBeenCalledTimes(1);
    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledTimes(1);
    expect(harness.setSlackAssistantSuggestedPrompts).not.toHaveBeenCalled();
  });

  it("accepts Slack assistant context when it is sent beside the thread", async () => {
    const harness = createHarness();

    await harness.handlers.assistant_thread_context_changed?.({
      event: makeTopLevelContextThreadEvent("assistant_thread_context_changed"),
      body: {},
    });

    expect(harness.saveSlackAssistantThreadContext).toHaveBeenCalledWith({
      assistantChannelId: "D123",
      threadTs: "1729999327.187299",
      userId: "U123",
      channelId: "C456",
      teamId: "T789",
      enterpriseId: "E123",
    });
  });

  it("drops mismatched workspace events before touching assistant state", async () => {
    const harness = createHarness({ shouldDrop: true });

    await harness.handlers.assistant_thread_started?.({
      event: makeThreadEvent("assistant_thread_started"),
      body: {},
    });

    expect(harness.trackEvent).not.toHaveBeenCalled();
    expect(harness.saveSlackAssistantThreadContext).not.toHaveBeenCalled();
    expect(harness.setSlackAssistantSuggestedPrompts).not.toHaveBeenCalled();
  });
});
