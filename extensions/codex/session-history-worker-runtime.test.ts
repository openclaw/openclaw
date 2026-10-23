import "openclaw/plugin-sdk/compiled-subprocess-testing";
import path from "node:path";
import {
  createCodexSessionContextReader,
  SessionTranscriptReadFenceError,
  type CodexSessionContextReader,
  type CodexSessionContextSnapshot,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessagesByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { projectCodexSettledHistoryInWorker as projectHistory } from "./session-history-worker-runtime.js";
import { settledFixture } from "./src/app-server/session-history.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

const sessionId = "actor-session";
const sessionTarget = {
  agentId: "main",
  sessionId,
  sessionKey: "agent:main:dashboard:incognito-history",
  storePath: "/synthetic/incognito.sqlite",
};
const { upstreamPrompt, settledMessages } = settledFixture();
const messages: CodexSessionContextSnapshot["messages"] = [
  { role: "user", content: "Earlier synthetic context.", timestamp: 1 },
  ...settledMessages,
];
const foreignError = new Error("History capability belongs to another actor target");
const owner = {
  assertCurrent(target: Parameters<CodexSessionContextReader>[0]) {
    if (Object.entries(sessionTarget).some(([key, value]) => Reflect.get(target, key) !== value)) {
      throw foreignError;
    }
  },
  read: vi.fn(async () => ({ header: { type: "session", id: sessionId }, messages })),
  validate: vi.fn(async (_snapshot: CodexSessionContextSnapshot) => {}),
  retain: <T>(operation: () => Promise<T>) => operation(),
};
const history = {
  agentId: sessionTarget.agentId,
  sessionId: sessionTarget.sessionId,
  sessionFile: `sqlite:main:${sessionTarget.sessionId}:${sessionTarget.storePath}`,
  mirroredMessages: settledMessages,
  settledMessages,
  turnId: "settled",
};
const reader = createCodexSessionContextReader(owner);
const target = { ...history, ...sessionTarget, sessionTarget };
beforeEach(() => [owner.read, owner.validate].forEach((mock) => mock.mockReset()));

it("passes the requested target to the bound capability before acquiring history", async () => {
  const foreignTarget = {
    ...target,
    agentId: "other",
    sessionTarget: { ...target.sessionTarget, agentId: "other" },
  };

  await expect(projectHistory(foreignTarget, undefined, reader)).rejects.toBe(foreignError);
  expect(owner.read).not.toHaveBeenCalled();
});

it("reports invalidated actor snapshots through the plugin rejection contract", async () => {
  owner.validate.mockRejectedValueOnce(new SessionTranscriptReadFenceError("Snapshot changed"));
  await expect(projectHistory(target, undefined, reader)).resolves.toEqual({
    status: "rejected",
    reason: "snapshot_invalidated",
  });
});

it("refuses cancellation during the final actor snapshot validation", async () => {
  const controller = new AbortController();
  const cancelled = new Error("History caller cancelled during validation");
  owner.validate.mockImplementationOnce(async () => controller.abort(cancelled));
  await expect(projectHistory(target, controller.signal, reader)).rejects.toBe(cancelled);
});

it("preserves owner-ended errors for caller recovery", async () => {
  const ended = Object.assign(new Error("Actor ended"), { code: "INCOGNITO_SESSION_ENDED" });
  owner.read.mockRejectedValueOnce(ended);
  await expect(projectHistory(target, undefined, reader)).rejects.toBe(ended);
});

it("resolves marker-only history through unbound memory routing without host SQL", async () => {
  setRuntimeConfigSnapshot({});
  onTestFinished(clearRuntimeConfigSnapshot);
  const stateDir = tempDirs.make("codex-marker-actor-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const memoryTarget = {
    ...target.sessionTarget,
    env,
    storePath: path.join(stateDir, "agents/main/agent/incognito-openclaw-agent.sqlite"),
  };
  onTestFinished(async () => {
    await deleteSessionEntry(memoryTarget);
  });
  await upsertSessionEntry({
    ...memoryTarget,
    entry: { sessionId: target.sessionId, updatedAt: 1, incognito: true },
  });
  await appendSessionTranscriptMessagesByIdentity({
    ...memoryTarget,
    messages: messages.map((message) => ({ message })),
  });
  const sql = observeHostDataSql();
  onTestFinished(() => sql.restore());
  const result = await projectHistory({
    ...history,
    sessionFile: `sqlite:main:${target.sessionId}:${memoryTarget.storePath}`,
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
});
