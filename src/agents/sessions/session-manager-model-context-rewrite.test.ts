import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { readTranscriptGenerationInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { rewriteTranscriptEventRowsExact } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

it("refreshes same-generation model sizes after a native rewrite and append", async () => {
  await withOpenClawTestState({ label: "model-context-rewrite-sizes" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "model-context-rewrite-sizes",
      sessionKey: "agent:main:model-context-rewrite-sizes",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    for (let index = 0; index < 12; index++) {
      source.appendMessage(makeUserMessage(`question-${index}: ${"x".repeat(256)}`, index));
    }
    const limits = { maxBytes: 2048, maxEvents: 20 };
    const read = () => SessionManager.openModelContextAsync(scope, { limits });
    const before = await read();
    const detached = before.buildSessionContext();
    const detachedBytes = JSON.stringify(detached);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
    const generation = readTranscriptGenerationInTransaction(database, scope.sessionId)!;
    const rows = readTranscriptEventRows(database, scope.sessionId).flatMap((row) => {
      const event = asOptionalRecord(JSON.parse(row.eventJson));
      const message = asOptionalRecord(event?.message);
      return event?.type === "message" && message?.role === "user"
        ? [
            {
              seq: row.seq,
              expectedEventJson: row.eventJson,
              event: {
                ...event,
                message: { ...message, __openclaw: { steerTargetRunId: "r".repeat(512) } },
              },
            },
          ]
        : [];
    });
    expect(
      await rewriteTranscriptEventRowsExact(scope, { expectedGeneration: generation, rows }),
    ).toEqual({ generation });
    source.appendMessage(makeUserMessage(`successor: ${"x".repeat(256)}`, 12));
    const warm = (await read()).buildSessionContext();
    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
    const reopened = (await read()).buildSessionContext();
    expect(JSON.stringify(warm)).toBe(JSON.stringify(reopened));
    expect(warm.messages.length).toBeLessThan(detached.messages.length);
    expect(Buffer.byteLength(JSON.stringify(warm.messages))).toBeLessThan(limits.maxBytes);
    expect(JSON.stringify(detached)).toBe(detachedBytes);
    expect(JSON.stringify(before.buildSessionContext())).toBe(detachedBytes);
  });
});
