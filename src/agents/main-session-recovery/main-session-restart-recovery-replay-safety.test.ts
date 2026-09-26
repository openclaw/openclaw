import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readMainSessionRecoveryCheckpoint } from "./main-session-restart-recovery-replay-safety.js";

let state: OpenClawTestState;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});

afterAll(async () => {
  await state?.cleanup();
});

const checkpoint = {
  role: "toolResult",
  toolName: "wait",
  content: [{ type: "text", text: '{"status":"waiting","runId":"code-run","replaySafe":true}' }],
};
const continuation = {
  role: "user",
  content: "Continue after restart",
  provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
};

async function seed(sessionId: string, messages: unknown[], incognito = false) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: incognito
      ? `agent:main:dashboard:incognito-${sessionId}`
      : `agent:main:${sessionId}`,
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", version: 3, id: sessionId },
    ...messages.map((message, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      message,
    })),
  ]);
  return scope;
}

it("classifies the full current turn without reading durable transcript payloads on the caller", async () => {
  const scope = await seed("durable-checkpoint", [
    {
      role: "user",
      content: "Original request",
      provenance: { kind: "inter_session", sourceTool: "agent_harness_task" },
    },
    checkpoint,
    ...Array.from({ length: 24 }, () => ({ role: "assistant", content: "Intermediate work" })),
    continuation,
  ]);
  // oxlint-disable-next-line typescript/unbound-method -- Forward the native operation with its exact database receiver.
  const prepare = DatabaseSync.prototype.prepare;
  const transcriptStatements: string[] = [];
  const observer = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    if (sql.includes("transcript_events")) {
      transcriptStatements.push(sql);
    }
    return prepare.call(this, sql);
  });
  try {
    await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toEqual({
      replaySafe: true,
      source: "harness_completion",
    });
    expect(transcriptStatements).toEqual([]);
  } finally {
    observer.mockRestore();
  }
});

it("does not borrow a previous turn or an inactive branch checkpoint", async () => {
  const scope = await seed("active-checkpoint", []);
  await replaceTranscriptEvents(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    {
      type: "message",
      id: "old",
      parentId: null,
      message: { role: "user", content: "Previous request" },
    },
    { type: "message", id: "old-checkpoint", parentId: "old", message: checkpoint },
    {
      type: "message",
      id: "new",
      parentId: "old-checkpoint",
      message: { role: "user", content: "New request" },
    },
    { type: "message", id: "inactive-checkpoint", parentId: "new", message: checkpoint },
    {
      type: "message",
      id: "active",
      parentId: "new",
      message: { role: "assistant", content: "Active work" },
    },
  ]);
  await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toEqual({
    replaySafe: false,
    source: "other",
  });
});

it.each([
  { kind: "internal_system", sourceTool: "other", source: "internal_system" },
  { kind: "inter_session", sourceTool: "subagent_announce", source: "completion" },
  { kind: "inter_session", sourceTool: "sessions_send", source: "inter_session" },
])(
  "preserves $source provenance through a restart continuation",
  async ({ kind, sourceTool, source }) => {
    const scope = await seed(`source-${source}`, [
      { role: "user", content: "Input", provenance: { kind, sourceTool } },
      continuation,
    ]);
    await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toEqual({
      replaySafe: false,
      source,
    });
  },
);

it("retains process-held incognito history", async () => {
  const scope = await seed(
    "private-checkpoint",
    [{ role: "user", content: "Private request" }, checkpoint, continuation],
    true,
  );
  await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toEqual({
    replaySafe: true,
    source: "other",
  });
});

it("preserves parse failures and releases the failed reader for the next read", async () => {
  const scope = await seed("malformed-checkpoint", [
    { role: "user", content: "Request" },
    checkpoint,
  ]);
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
  );
  const original = database.db
    .prepare(
      "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(scope.sessionId) as { seq: number; event_json: string };
  const update = database.db.prepare(
    "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?",
  );
  try {
    update.run("{malformed", scope.sessionId, original.seq);
    await expect(readMainSessionRecoveryCheckpoint(scope)).rejects.toBeInstanceOf(SyntaxError);
  } finally {
    update.run(original.event_json, scope.sessionId, original.seq);
  }
  await expect(readMainSessionRecoveryCheckpoint(scope)).resolves.toEqual({
    replaySafe: true,
    source: "other",
  });
});
