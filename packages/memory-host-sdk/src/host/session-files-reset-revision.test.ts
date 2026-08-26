import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistSessionTranscriptTurn,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { hashText } from "./hash.js";
import {
  buildSessionEntry,
  matchesSessionEntryPrefixHash,
  type SessionFileEntry,
} from "./session-files.js";

function requireSessionEntry(entry: SessionFileEntry | null): SessionFileEntry {
  if (!entry) {
    throw new Error("expected session entry");
  }
  return entry;
}

function legacySessionEntryHash(entry: SessionFileEntry): string {
  return hashText(
    entry.content +
      "\n" +
      entry.lineMap.join(",") +
      "\n" +
      entry.messageTimestampsMs.join(",") +
      "\n" +
      JSON.stringify(entry.lineProvenance),
  );
}

let tmpDir: string;
let previousStateDir: string | undefined;
let previousConfigPath: string | undefined;

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-reset-revision-test-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
  if (previousConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
  } else {
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", previousConfigPath);
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SQLite session reset content revision", () => {
  it("invalidates current and legacy prefix hashes across a reset generation", async () => {
    const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionKey = "agent:main:chat:reset-revision";
    const sessionId = "reset-revision";
    fsSync.mkdirSync(sessionsDir, { recursive: true });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "user", content: "unchanged exported text" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const buildOptions = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      updatedAtMs: 1,
    };
    const before = requireSessionEntry(await buildSessionEntry(sessionKey, buildOptions));
    const beforeLineCount = before.content.split("\n").length;
    const legacyBeforeHash = legacySessionEntryHash(before);

    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        messages: [{ message: { role: "assistant", content: "ordinary appended text" } }],
        touchSessionEntry: true,
        updateMode: "none",
      },
    );
    const afterAppend = requireSessionEntry(await buildSessionEntry(sessionKey, buildOptions));
    expect(matchesSessionEntryPrefixHash(afterAppend, beforeLineCount, before.hash)).toBe(true);
    expect(matchesSessionEntryPrefixHash(afterAppend, beforeLineCount, legacyBeforeHash)).toBe(
      true,
    );

    await resetSessionEntryLifecycle({
      agentId: "main",
      buildNextEntry: ({ currentEntry }) => ({
        ...currentEntry,
        sessionId,
        updatedAt: 2,
      }),
      resetBoundaryReason: "reset",
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    const after = requireSessionEntry(await buildSessionEntry(sessionKey, buildOptions));
    expect(after.content).toBe(afterAppend.content);
    expect(after.lineMap).toEqual(afterAppend.lineMap);
    const cutoffSymbol = Symbol.for("openclaw.memory.sessionResetRecallCutoff");
    expect(Object.getOwnPropertyDescriptor(after, cutoffSymbol)).toMatchObject({
      enumerable: false,
      value: { state: "valid", cutoffLine: expect.any(Number) },
    });
    expect(Object.keys(after)).not.toContain(cutoffSymbol.description);
    expect(after.hash).not.toBe(before.hash);
    expect(matchesSessionEntryPrefixHash(after, beforeLineCount, before.hash)).toBe(false);
    expect(matchesSessionEntryPrefixHash(after, beforeLineCount, legacyBeforeHash)).toBe(false);
  });
});
