import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import { buildCompactionPersistenceGuard } from "./attempt-session-manager-prepare.js";

describe("buildCompactionPersistenceGuard", () => {
  it("leaves SQLite compaction persistence to the transcript owner", () => {
    const withOwnedSessionFileWrite = vi.fn();

    const guard = buildCompactionPersistenceGuard({
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-1",
        storePath: "/tmp/openclaw-agent.sqlite",
      }),
      sessionLockController: { withOwnedSessionFileWrite },
    });

    expect(guard).toEqual({});
    expect(withOwnedSessionFileWrite).not.toHaveBeenCalled();
  });

  it("wraps JSONL compaction appends in the session-file ownership fence", () => {
    const withOwnedSessionFileWrite = vi.fn((append: () => string) => append());
    const append = vi.fn(() => "entry-1");
    const validateAppend = vi.fn(() => true);

    const guard = buildCompactionPersistenceGuard({
      sessionFile: "/tmp/session.jsonl",
      sessionLockController: { withOwnedSessionFileWrite },
    });
    const entryId = guard.withCompactionPersistence?.(append, validateAppend);

    expect(entryId).toBe("entry-1");
    expect(withOwnedSessionFileWrite).toHaveBeenCalledWith(append, validateAppend);
  });
});
