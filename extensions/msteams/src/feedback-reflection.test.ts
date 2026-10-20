import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFeedbackReflection } from "./feedback-reflection.js";
import type { MSTeamsApp } from "./sdk.js";

const mocks = vi.hoisted(() => ({ reflect: vi.fn(), send: vi.fn() }));

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS: 300_000,
  runChannelFeedbackReflection: mocks.reflect,
}));
vi.mock("./sdk-proactive.js", () => ({ sendMSTeamsActivityWithReference: mocks.send }));
vi.mock("./messenger.js", () => ({ buildConversationReference: (value: unknown) => value }));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

function reflect(conversationType = "personal") {
  const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
  return {
    log,
    operation: runFeedbackReflection({
      cfg: {},
      app: {} as MSTeamsApp,
      accountId: "default",
      conversationRef: { conversation: { id: "conversation", conversationType } },
      sessionKey: "session",
      agentId: "main",
      conversationId: "conversation",
      conversationKind: conversationType === "personal" ? "direct" : "channel",
      log,
    }),
  };
}

describe("MSTeams reflection completion", () => {
  it.each([
    ["personal", true],
    ["channel", false],
  ] as const)(
    "sends the completed reflection follow-up only in a direct message: %s",
    async (kind, sent) => {
      mocks.reflect.mockResolvedValue({
        status: "complete",
        storePath: "/synthetic/sessions",
        learning: "Synthetic learning",
        responseLength: 6,
        followUp: true,
        userMessage: "Synthetic follow-up",
      });

      await reflect(kind).operation;

      expect(mocks.reflect).toHaveBeenCalledOnce();
      if (sent) {
        expect(mocks.send).toHaveBeenCalledWith(
          expect.any(Object),
          expect.any(Object),
          { type: "message", text: "Synthetic follow-up" },
          expect.objectContaining({ accountId: "default" }),
        );
      } else {
        expect(mocks.send).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["cooldown", "empty"])("does not send after a %s reflection", async (status) => {
    mocks.reflect.mockResolvedValue({ status });
    await reflect().operation;
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("records a dispatch failure without sending a follow-up", async () => {
    mocks.reflect.mockRejectedValue(new Error("dispatch unavailable"));
    const { log, operation } = reflect();
    await operation;
    expect(log.error).toHaveBeenCalledWith("reflection dispatch failed", {
      error: "dispatch unavailable",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
