import "openclaw/plugin-sdk/compiled-subprocess-testing";
import {
  createCodexSessionContextReader,
  SessionTranscriptReadFenceError,
  type CodexSessionContextReader,
  type CodexSessionContextSnapshot,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import { appendSessionTranscriptMessagesByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionActor,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { projectCodexSettledHistoryInWorker } from "./session-history-worker-runtime.js";
import { settledFixture } from "./src/app-server/session-history.test-support.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function actorHistoryFixture() {
  const sessionTarget = {
    agentId: "main",
    sessionId: "actor-session",
    sessionKey: "agent:main:dashboard:incognito-history",
    storePath: "/synthetic/incognito.sqlite",
  };
  const { upstreamPrompt, settledMessages } = settledFixture();
  const snapshot: CodexSessionContextSnapshot = {
    header: { type: "session", id: sessionTarget.sessionId },
    messages: [
      { role: "user", content: "Earlier synthetic context.", timestamp: 1 },
      ...settledMessages,
    ],
  };
  const owner = {
    assertCurrent(target: Parameters<CodexSessionContextReader>[0]) {
      if (
        target.agentId !== sessionTarget.agentId ||
        target.sessionId !== sessionTarget.sessionId ||
        target.sessionKey !== sessionTarget.sessionKey ||
        target.storePath !== sessionTarget.storePath
      ) {
        throw new Error("History capability belongs to another actor target");
      }
    },
    read: vi.fn(async () => snapshot),
    validate: vi.fn(async (_snapshot: CodexSessionContextSnapshot) => {}),
    retain: <T>(operation: () => Promise<T>) => operation(),
  };
  return {
    owner,
    reader: createCodexSessionContextReader(owner),
    upstreamPrompt,
    target: {
      ...sessionTarget,
      sessionTarget,
      sessionFile: `sqlite:main:${sessionTarget.sessionId}:${sessionTarget.storePath}`,
      mirroredMessages: settledMessages,
      settledMessages,
      turnId: "settled",
    },
  };
}

describe("Codex actor history adapter", () => {
  it("passes the requested target to the bound capability before acquiring history", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const foreignTarget = {
      ...target,
      agentId: "other",
      sessionTarget: { ...target.sessionTarget, agentId: "other" },
    };

    await expect(
      projectCodexSettledHistoryInWorker(foreignTarget, undefined, reader),
    ).rejects.toThrow("History capability belongs to another actor target");
    expect(owner.read).not.toHaveBeenCalled();
  });

  it("reports invalidated actor snapshots through the plugin rejection contract", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    owner.validate.mockRejectedValueOnce(new SessionTranscriptReadFenceError("Snapshot changed"));

    await expect(projectCodexSettledHistoryInWorker(target, undefined, reader)).resolves.toEqual({
      status: "rejected",
      reason: "snapshot_invalidated",
    });
  });

  it("refuses cancellation during the final actor snapshot validation", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const controller = new AbortController();
    const cancelled = new Error("History caller cancelled during validation");
    owner.validate.mockImplementationOnce(async () => controller.abort(cancelled));

    await expect(
      projectCodexSettledHistoryInWorker(target, controller.signal, reader),
    ).rejects.toBe(cancelled);
  });

  it("preserves owner-ended errors for caller recovery", async () => {
    const { target, reader, owner } = actorHistoryFixture();
    const ended = Object.assign(new Error("Actor ended"), { code: "INCOGNITO_SESSION_ENDED" });
    owner.read.mockRejectedValueOnce(ended);

    await expect(projectCodexSettledHistoryInWorker(target, undefined, reader)).rejects.toBe(ended);
  });

  it("resolves marker-only history through the captured actor without host SQL", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("codex-marker-actor-") };
    const authority = { assertCurrent() {} };
    const actor = await openIncognitoTestActor(env, authority);
    const { target, upstreamPrompt } = actorHistoryFixture();
    const sessionTarget = { ...target.sessionTarget, storePath: actor.path };
    try {
      await actor.sessions.create(authority, {
        sessionKey: sessionTarget.sessionKey,
        entry: { sessionId: target.sessionId, updatedAt: 1, incognito: true },
      });
      await withIncognitoSessionActor(actor, async () => {
        await appendSessionTranscriptMessagesByIdentity({
          ...sessionTarget,
          messages: [
            { role: "user" as const, content: "Earlier synthetic context.", timestamp: 1 },
            ...target.settledMessages,
          ].map((message) => ({ message })),
        });
        const sql = observeHostDataSql();
        try {
          const result = await projectCodexSettledHistoryInWorker({
            agentId: "main",
            sessionId: target.sessionId,
            sessionFile: `sqlite:main:${target.sessionId}:${actor.path}`,
            mirroredMessages: target.mirroredMessages,
            settledMessages: target.settledMessages,
            turnId: target.turnId,
          });
          expect(result).toMatchObject({
            status: "ok",
            value: [
              { role: "user", content: [{ text: "Earlier synthetic context." }] },
              { role: "user", content: [{ text: upstreamPrompt }] },
              { type: "function_call", call_id: "sent" },
              { type: "function_call_output", call_id: "sent" },
            ],
          });
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
      });
    } finally {
      await actor.close();
    }
  });
});
