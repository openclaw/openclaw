import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSessionEntry: vi.fn(),
  corpusEntries: vi.fn(),
  isSessionArchiveArtifactName: vi.fn(() => false),
  replaceArtifactMappings: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  buildSessionEntry: mocks.buildSessionEntry,
  isSessionArchiveArtifactName: mocks.isSessionArchiveArtifactName,
  listSessionTranscriptCorpusEntriesForAgent: mocks.corpusEntries,
  resolveSessionIdentityForTranscriptFile: () => null,
}));

vi.mock("../qmd-session-artifacts.js", () => ({
  refreshQmdSessionArtifactDocIds: vi.fn(),
  replaceQmdSessionArtifactMappings: mocks.replaceArtifactMappings,
}));

import { QmdSessionExporter } from "./qmd-session-exporter.js";

const createLease = () => ({
  assertOwned: vi.fn(),
  signal: new AbortController().signal,
});

describe("QmdSessionExporter", () => {
  beforeEach(() => {
    mocks.buildSessionEntry.mockReset();
    mocks.corpusEntries.mockReset();
    mocks.isSessionArchiveArtifactName.mockReset().mockReturnValue(false);
    mocks.replaceArtifactMappings.mockReset();
  });

  it("skips unchanged transcript parsing by canonical corpus revision", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockImplementation(async () => [corpusEntry]);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: first",
        hash: "first",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );
      const lease = createLease();

      await exporter.exportSessions(lease);
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(path.join(exportDir, "session-1.md"), "utf8")).resolves.toContain(
        "User: first",
      );

      corpusEntry.contentRevision = "sqlite:2:200:2:2";
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: second",
        hash: "second",
        lineMap: [1],
        messageTimestampsMs: [2],
        mtimeMs: 2,
        path: "sessions/main/session-1.jsonl",
        size: 200,
      });
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(path.join(exportDir, "session-1.md"), "utf8")).resolves.toContain(
        "User: second",
      );
    });
  });

  it("atomically repairs a missing or replaced export without hashing the transcript", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockResolvedValue([corpusEntry]);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: canonical",
        hash: "canonical",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );
      const target = path.join(exportDir, "session-1.md");
      const lease = createLease();

      await exporter.exportSessions(lease);
      await fs.writeFile(target, "corrupt", "utf8");
      await exporter.exportSessions(lease);
      await fs.rm(target);
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(3);
      await expect(fs.readFile(target, "utf8")).resolves.toContain("User: canonical");
    });
  });

  // scope/memory-recall-enforcement-latency-20260718.md Deliverable A step 2a diagnosis
  // + B.3 step 2b repair (card ff37a4e4-e002-4fb2-93ad-8b5e0a2fd3d3): an archived session's
  // exported artifact name embeds a raw ISO timestamp (dots/colons). QMD's own indexer
  // normalizes those to "-" in its `documents` table, so the stored artifact_path/search_path
  // must match that normalized form or refreshQmdSessionArtifactDocIds()'s join on
  // (collection, path) can never backfill a docid for it.
  it("normalizes an archived session's artifact/search path to match QMD's own indexed name", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const rawStem = "abc123.jsonl.deleted.2026-07-18T12:00:00.000Z";
      const corpusEntry = {
        agentId: "main",
        artifactKind: "archived-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: `sqlite:main:${rawStem}`,
        sessionId: rawStem,
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockResolvedValue([corpusEntry]);
      mocks.isSessionArchiveArtifactName.mockReturnValue(true);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: archived",
        hash: "archived",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: `sessions/main/${rawStem}.jsonl`,
        size: 100,
      });
      // Echo the (possibly normalized) artifactPath back so the mapping's searchPath
      // reflects whatever buildSessionArtifactMapping actually passed it.
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        (_collection, artifactPath) => `echo:${artifactPath}`,
      );
      const lease = createLease();

      await exporter.exportSessions(lease);

      expect(mocks.replaceArtifactMappings).toHaveBeenCalledTimes(1);
      const firstCall = mocks.replaceArtifactMappings.mock.calls[0];
      if (!firstCall) {
        throw new Error("expected replaceArtifactMappings to be called");
      }
      const { mappings } = firstCall[0] as {
        mappings: Array<{ artifactPath: string; searchPath: string; archived: boolean }>;
      };
      expect(mappings).toHaveLength(1);
      const mapping = mappings[0];
      if (!mapping) {
        throw new Error("expected one artifact mapping");
      }
      expect(mapping.archived).toBe(true);
      // Dots and colons in the stem become "-"; the ".md" extension is preserved.
      expect(mapping.artifactPath).toBe("abc123-jsonl-deleted-2026-07-18T12-00-00-000Z.md");
      expect(mapping.artifactPath).not.toContain(".jsonl.");
      expect(mapping.artifactPath).not.toContain(":");
      // The on-disk exported file itself keeps the raw, un-normalized name.
      await expect(fs.readFile(path.join(exportDir, `${rawStem}.md`), "utf8")).resolves.toContain(
        "User: archived",
      );
      // searchPath is derived from the (normalized) artifactPath, not the raw one.
      expect(mapping.searchPath).toBe(`echo:${mapping.artifactPath}`);
    });
  });

  it("leaves a live (non-archived) session's artifact path untouched", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockResolvedValue([corpusEntry]);
      mocks.isSessionArchiveArtifactName.mockReturnValue(false);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: live",
        hash: "live",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        (_collection, artifactPath) => `echo:${artifactPath}`,
      );
      const lease = createLease();

      await exporter.exportSessions(lease);

      const firstCall = mocks.replaceArtifactMappings.mock.calls[0];
      if (!firstCall) {
        throw new Error("expected replaceArtifactMappings to be called");
      }
      const { mappings } = firstCall[0] as {
        mappings: Array<{ artifactPath: string; archived: boolean }>;
      };
      const mapping = mappings[0];
      if (!mapping) {
        throw new Error("expected one artifact mapping");
      }
      expect(mapping.archived).toBe(false);
      expect(mapping.artifactPath).toBe("session-1.md");
    });
  });
});
