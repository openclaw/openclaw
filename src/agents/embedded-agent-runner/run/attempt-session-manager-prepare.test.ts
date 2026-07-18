import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { buildCompactionPersistenceGuard } from "./attempt-session-manager-prepare.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";

function createOwnedSessionFileWriteMock() {
  const calls = vi.fn();
  const withOwnedSessionFileWrite: EmbeddedAttemptSessionLockController["withOwnedSessionFileWrite"] =
    (append, validateAppend) => {
      calls(append, validateAppend);
      return append();
    };
  return { calls, withOwnedSessionFileWrite };
}

describe("buildCompactionPersistenceGuard", () => {
  it("leaves SQLite compaction persistence to the transcript owner", () => {
    const { calls, withOwnedSessionFileWrite } = createOwnedSessionFileWriteMock();

    const guard = buildCompactionPersistenceGuard({
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-1",
        storePath: "/tmp/openclaw-agent.sqlite",
      }),
      sessionLockController: { withOwnedSessionFileWrite },
    });

    expect(guard).toEqual({});
    expect(calls).not.toHaveBeenCalled();
  });

  it("wraps JSONL compaction appends in the session-file ownership fence", () => {
    const { calls, withOwnedSessionFileWrite } = createOwnedSessionFileWriteMock();
    const append = vi.fn(() => "entry-1");
    const validateAppend = vi.fn(() => true);

    const guard = buildCompactionPersistenceGuard({
      sessionFile: "/tmp/session.jsonl",
      sessionLockController: { withOwnedSessionFileWrite },
    });
    const entryId = guard.withCompactionPersistence?.(append, validateAppend);

    expect(entryId).toBe("entry-1");
    expect(calls).toHaveBeenCalledWith(append, validateAppend);
  });
});
