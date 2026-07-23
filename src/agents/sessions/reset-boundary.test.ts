import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendSessionResetBoundary, rollbackSessionResetBoundary } from "./reset-boundary.js";
import { SessionManager } from "./session-manager.js";

const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reset transcript boundary", () => {
  it("restores the previous visible leaf when the paired row commit fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-boundary-"));
    tempDirs.push(dir);
    const scope = {
      agentId: "main",
      sessionId: "reset-boundary-session",
      sessionKey: "agent:main:main",
      storePath: path.join(dir, "sessions.json"),
    };
    const sessionFile = formatSqliteSessionFileMarker(scope);
    await upsertSessionEntry(scope, {
      sessionFile,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const user = await appendTranscriptMessage(scope, {
      eventId: "user-before-reset",
      message: { role: "user", content: "before reset" },
      parentId: null,
    });
    await appendTranscriptMessage(scope, {
      eventId: "assistant-before-reset",
      message: { role: "assistant", content: "answer" },
      parentId: user.messageId,
    });

    const boundary = appendSessionResetBoundary({
      reason: "new",
      sessionFile,
      sessionKey: scope.sessionKey,
    });
    expect(boundary).toBeDefined();
    if (!boundary) {
      throw new Error("expected reset boundary");
    }
    expect(SessionManager.open(sessionFile).getBranch().at(-1)?.type).toBe("reset");

    rollbackSessionResetBoundary(boundary);

    const restored = SessionManager.open(sessionFile);
    expect(restored.getLeafId()).toBe(boundary.previousLeafId);
    expect(restored.getBranch().some((entry) => entry.type === "reset")).toBe(false);
  });

  it("rejects an unreadable transcript instead of acknowledging a reset", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-boundary-unreadable-"));
    tempDirs.push(dir);

    expect(() => appendSessionResetBoundary({ reason: "reset", sessionFile: dir })).toThrow();
  });
});
