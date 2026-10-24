import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";

const mocks = vi.hoisted(() => ({ reflect: vi.fn(), send: vi.fn() }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS: 300_000,
  runChannelFeedbackReflection: mocks.reflect,
  recordChannelFeedbackEvent: vi.fn(async () => true),
}));
vi.mock("./sdk-proactive.js", () => ({ sendMSTeamsActivityWithReference: mocks.send }));
vi.mock("./messenger.js", () => ({ buildConversationReference: (value: unknown) => value }));

beforeEach(() => {
  vi.resetAllMocks();
  installMSTeamsTestRuntime();
});
afterEach(() => vi.restoreAllMocks());

function reflect(conversationType = "personal") {
  const completed = createDeferred<void>();
  const log = {
    debug: vi.fn((message: string) => {
      if (
        message === "skipping reflection (cooldown active)" ||
        message === "reflection produced no output" ||
        message === "skipping reflection follow-up outside direct message" ||
        message === "failed to send reflection follow-up"
      ) {
        completed.resolve();
      }
    }),
    error: vi.fn(() => completed.resolve()),
    info: vi.fn(),
  };
  mocks.send.mockImplementation(async () => completed.resolve());
  const deps = createMSTeamsMessageHandlerDeps({
    cfg: {
      channels: { msteams: { dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" } },
    },
  });
  deps.log = log;
  const invoke = runMSTeamsFeedbackInvokeHandler(
    {
      activity: {
        type: "invoke",
        id: "feedback-invoke",
        from: { id: "user", aadObjectId: "user" },
        conversation: { id: "conversation", conversationType },
        value: { actionName: "feedback", actionValue: { reaction: "dislike" } },
      },
      sendActivity: vi.fn(async () => undefined),
      updateActivity: vi.fn(async () => undefined),
    },
    deps,
  );
  return {
    log,
    operation: invoke.then(async () => {
      await completed.promise;
      await Promise.allSettled(mocks.send.mock.results.map((result) => result.value));
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
