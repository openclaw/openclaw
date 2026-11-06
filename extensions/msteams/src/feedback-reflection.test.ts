import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import {
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";

const mocks = vi.hoisted(() => ({ reflect: vi.fn(), send: vi.fn() }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  runChannelFeedbackReflection: mocks.reflect,
  recordChannelFeedbackEvent: vi.fn(async () => true),
}));
vi.mock("./sdk-proactive.js", () => ({ sendMSTeamsActivityWithReference: mocks.send }));
vi.mock("./messenger.js", () => ({ buildConversationReference: (value: unknown) => value }));

beforeEach(() => {
  vi.resetAllMocks();
  installMSTeamsTestRuntime();
});

async function reflect(conversationType = "personal") {
  const completed = createDeferred<void>();
  const log = {
    debug: vi.fn((message: string) => {
      if (
        message === "skipping reflection (cooldown active)" ||
        message === "reflection produced no output" ||
        message === "skipping reflection follow-up outside direct message"
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
  await runMSTeamsFeedbackInvokeHandler(
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
  await completed.promise;
  await Promise.allSettled(mocks.send.mock.results.map((result) => result.value));
  return log;
}

describe("MSTeams reflection completion", () => {
  const complete = { status: "complete", followUp: true, userMessage: "Synthetic follow-up" };
  it.each([
    ["personal", complete, true],
    ["channel", complete, false],
    ["personal", { status: "cooldown" }, false],
    ["personal", { status: "empty" }, false],
  ] as const)("handles %s reflection %j (send=%s)", async (kind, result, sent) => {
    mocks.reflect.mockResolvedValue(result);
    await reflect(kind);
    expect(mocks.send.mock.calls.map((call) => [call[2], call[3].accountId])).toEqual(
      sent ? [[{ type: "message", text: "Synthetic follow-up" }, "default"]] : [],
    );
  });

  it("records a dispatch failure without sending a follow-up", async () => {
    mocks.reflect.mockRejectedValue(new Error("dispatch unavailable"));
    const log = await reflect();
    expect(log.error).toHaveBeenCalledWith("reflection dispatch failed", {
      error: "dispatch unavailable",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
