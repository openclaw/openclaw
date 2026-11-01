import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, vi } from "vitest";
import {
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import {
  listMemoryEntryOrigins,
  recordMemoryEntryOrigins,
  type MemoryEntryOrigin,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryForgetFixture } from "./memory-forget.test-helpers.js";
import { readMemoryForgetTombstonesForTest } from "./test-helpers.js";

export function memoryForgetHarness() {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });
  return {
    get cfg() {
      return fixture.cfg;
    },
    set cfg(value) {
      fixture.cfg = value;
    },
    get workspaceDir() {
      return fixture.workspaceDir;
    },
    get stateDir() {
      return fixture.stateDir;
    },
    forget: (
      selectors: Omit<Parameters<typeof forgetMemoryEntries>[0], "cfg" | "agentId">,
      agentId = "main",
    ) => forgetMemoryEntries({ cfg: fixture.cfg, agentId, ...selectors }),
    origins: (
      filters: Omit<Parameters<typeof listMemoryEntryOrigins>[0], "agentId"> = {},
      agentId = "main",
    ) => listMemoryEntryOrigins({ agentId, ...filters }),
    tombstones: () => readMemoryForgetTombstonesForTest({ agentId: "main" }),
    readText: (file: string) => fs.readFile(file, "utf8"),
    path: (...parts: string[]) => path.join(fixture.workspaceDir, ...parts),
    write: (file: string, content: string) =>
      fs.writeFile(path.join(fixture.workspaceDir, file), content),
    read: (file: string) => fs.readFile(path.join(fixture.workspaceDir, file), "utf8"),
    recordOrigins: (
      origins: Parameters<typeof recordMemoryEntryOrigins>[0]["origins"],
      agentId = "main",
    ) => recordMemoryEntryOrigins({ agentId, origins }),
    readEntries: <T>(namespace: string) =>
      readMemoryCoreWorkspaceEntries<T>({ namespace, workspaceDir: fixture.workspaceDir }),
    writeEntries: (namespace: string, entries: Array<{ key: string; value: unknown }>) =>
      writeMemoryCoreWorkspaceEntries({ namespace, workspaceDir: fixture.workspaceDir, entries }),
    writeEntry: (namespace: string, key: string, value: unknown) =>
      writeMemoryCoreWorkspaceEntry({ namespace, workspaceDir: fixture.workspaceDir, key, value }),
    archive: (sessionId: string) =>
      deleteSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:${sessionId}`,
        expectedSessionId: sessionId,
        archiveTranscript: true,
      }),
    append: <T>(sessionId: string, message: T) =>
      appendSessionTranscriptMessageByIdentity({
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        message,
      }),
    seedSession: (sessionId: string, agentId = "main") =>
      upsertSessionEntry({
        agentId,
        sessionKey: `agent:${agentId}:${sessionId}`,
        entry: { sessionId, updatedAt: 1_000 },
      }),
  };
}

export function memoryOrigin(
  entryKey: string,
  sessionId: string,
  options: Partial<MemoryEntryOrigin> = {},
): MemoryEntryOrigin {
  return {
    entryKey,
    sessionId,
    agentId: "main",
    sessionKey: `agent:main:${sessionId}`,
    originClass: "owner",
    observedAt: 1_000,
    ...options,
  };
}

export function memoryBackup(content: string, key = "backup") {
  return {
    key,
    value: {
      createdAt: "2026-08-25T00:00:00.000Z",
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    },
  };
}

export function memoryIndexFixture(
  db: Pick<ReturnType<typeof openOpenClawAgentDatabase>["db"], "prepare">,
) {
  return {
    chunk(
      id: string,
      filePath: string,
      {
        source = "sessions",
        text = "forget",
        hash = "fixture-hash",
        model = "test",
        endLine = 1,
        embedding = new Uint8Array<ArrayBufferLike>(new ArrayBuffer(0)),
      } = {},
    ) {
      const insert = db.prepare(`INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      insert.run(id, filePath, source, 1, endLine, hash, model, text, embedding);
    },
    source(filePath: string, source: string, hash: string) {
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 1, 1)",
      ).run(filePath, source, hash);
    },
    provenance(id: string, origin = "agent", kind = "interactive") {
      db.prepare(
        "INSERT INTO memory_index_chunk_provenance (chunk_id, origin_class, session_kind, observed_at) VALUES (?, ?, ?, 1)",
      ).run(id, origin, kind);
    },
  };
}
