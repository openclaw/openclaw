import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  agentCommand,
  compactionTestRuntime,
  compactionTestState as state,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "../agent-command.compaction.test-support.js";
const { appendTranscriptMessage, loadSessionEntry, loadTranscriptEvents, replaceSessionEntry } =
  compactionTestRuntime;
registerAgentCommandCompactionTestHooks();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
  state.runAgentAttemptMock.mockImplementation(async (params) => {
    await expectDefined(
      params.userTurnTranscriptRecorder,
      "command user recorder",
    ).persistApproved();
    return makeCompactionResult({
      sessionId: params.sessionId,
      text: "The new turn completed.",
      runner: "embedded",
    });
  });
});
afterEach(() => vi.useRealTimers());

async function seedExpiredSession(mode: "idle" | "daily") {
  const cfg = expectDefined(state.cfg, "command config");
  cfg.session = {
    ...cfg.session,
    reset: mode === "idle" ? { mode, idleMinutes: 1 } : { mode, atHour: 4 },
  };
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "durable-transcript",
    storePath: requireCompactionStorePath(),
  };
  const expiredAt = mode === "idle" ? Date.now() - 120_000 : new Date(2026, 9, 19, 12).getTime();
  const entry = {
    sessionId: target.sessionId,
    lifecycleRevision: "before-expiry",
    updatedAt: expiredAt,
    sessionStartedAt: expiredAt,
    lastInteractionAt: expiredAt,
  };
  await replaceSessionEntry(target, entry);
  await appendTranscriptMessage(target, {
    message: makeUserMessage("Before expiry: AMBER731", expiredAt),
  });
  // Transcript setup must not make the deliberately expired row fresh.
  await replaceSessionEntry(target, entry);
  return target;
}

it.each(["idle", "daily"] as const)(
  "appends one %s reset boundary while retaining the command transcript identity",
  async (mode) => {
    const target = await seedExpiredSession(mode);
    await agentCommand({
      message: "After expiry: COBALT942",
      sessionKey: mode === "idle" ? target.sessionKey.toUpperCase() : target.sessionKey,
    });

    expect(loadSessionEntry(target)).toMatchObject({
      sessionId: "durable-transcript",
      lifecycleRevision: expect.any(String),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
    });
    expect(loadSessionEntry(target)?.lifecycleRevision).not.toBe("before-expiry");
    const events = await loadTranscriptEvents(target);
    expect(events.filter((event) => isRecord(event) && event.type === "reset")).toEqual([
      expect.objectContaining({ reason: mode }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "Before expiry: AMBER731" }),
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: expect.stringContaining("COBALT942") }),
        }),
      ]),
    );

    await agentCommand({ message: "Continue the fresh session.", sessionKey: target.sessionKey });
    expect(
      (await loadTranscriptEvents(target)).filter(
        (event) => isRecord(event) && event.type === "reset",
      ),
    ).toHaveLength(1);
  },
);

it("resumes an explicitly requested expired session without a reset boundary", async () => {
  const target = await seedExpiredSession("idle");
  await agentCommand({
    message: "Explicitly resume this transcript.",
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
  });

  expect(loadSessionEntry(target)).toMatchObject({
    sessionId: "durable-transcript",
    lifecycleRevision: "before-expiry",
  });
  expect(
    (await loadTranscriptEvents(target)).filter(
      (event) => isRecord(event) && event.type === "reset",
    ),
  ).toEqual([]);
});
