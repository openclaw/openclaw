import { expect, it, vi } from "vitest";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";

const [appendMessage, publishUpdate] = vi.hoisted(() => [vi.fn(), vi.fn()] as const);

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  appendSessionTranscriptMessageByIdentity: appendMessage,
  publishSessionTranscriptUpdateByIdentity: publishUpdate,
}));

it("publishes a model-excluded activity once per transcript identity", async () => {
  appendMessage
    .mockImplementationOnce(async ({ message }: { message: unknown }) => ({
      appended: true,
      message,
      messageId: "activity-message",
    }))
    .mockResolvedValueOnce({ appended: false, message: {}, messageId: "activity-message" });
  const activity = {
    sessionTarget: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: "/state/openclaw-agent.sqlite",
    },
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "compact-1",
    timestamp: 123,
    runId: "run-1",
  };

  await persistCodexContextCompactionActivity(activity);
  await persistCodexContextCompactionActivity(activity);

  expect(appendMessage).toHaveBeenCalledTimes(2);
  expect(appendMessage.mock.calls[0]?.[0].message.usage).toEqual({
    contextUsage: { state: "unavailable" },
  });
  expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({
    eventId: "codex-context-compaction:thread-1:turn-1:compact-1",
    message: {
      role: "custom",
      customType: "openclaw.context-compaction",
      display: true,
      excludeFromContext: true,
      idempotencyKey: "codex-context-compaction:thread-1:turn-1:compact-1",
      __openclaw: { runId: "run-1", itemId: "compact-1" },
    },
  });
  expect(publishUpdate).toHaveBeenCalledOnce();
  expect(publishUpdate.mock.calls[0]?.[0]).toMatchObject({
    update: { messageId: "activity-message", runId: "run-1" },
  });
});
