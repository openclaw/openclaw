import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  foreignSessionIngestionSource,
  resolveAdmissionPolicy,
  scanSessionIngestionSource,
  sessionExclusionReason,
  sessionIngestionSourceFromCorpus,
} from "./session-ingestion.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session ingestion", () => {
  it.each(["email", "gmail"] as const)(
    "applies exact %s admission policy using the corpus session store",
    async (hookExternalContentSource) => {
      const dir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-admission-")),
      );
      tempDirs.push(dir);
      vi.stubEnv("OPENCLAW_STATE_DIR", dir);
      const storePath = path.join(dir, "custom", "sessions.json");
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const sessionId = "source-session";
      const sessionKey = "agent:main:source-session";
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey,
        entry: { sessionId, updatedAt: 1_000, hookExternalContentSource },
      });
      const source = sessionIngestionSourceFromCorpus({
        agentId: "main",
        artifactKind: "active-session",
        transcriptSource: "sqlite",
        sessionFile: sessionKey,
        sessionId,
        sessionKey,
        storePath,
        sessionKind: "interactive",
      });
      expect(source).not.toBeNull();
      if (!source) {
        throw new Error("Interactive source was not available");
      }
      const policy = resolveAdmissionPolicy({
        memoryPolicy: {
          excludeSessions: { hookExternalContentSources: [hookExternalContentSource] },
        },
      });
      expect(sessionExclusionReason(source, policy)).toBe(
        `hookExternalContentSource:${hookExternalContentSource}`,
      );
    },
  );

  it.each([
    {
      name: "session id ending in .jsonl",
      sessionFile: path.join(os.tmpdir(), "foo.jsonl.jsonl"),
      sessionId: "foo.jsonl",
    },
    {
      name: "bounded archive filename",
      sessionFile: path.join(
        os.tmpdir(),
        `session-${"a".repeat(64)}.jsonl.deleted.2026-08-11T08-00-00.000Z.zst`,
      ),
      sessionId: `oversized-${"x".repeat(300)}`,
    },
  ])("preserves file-backed scope identity for $name", ({ sessionFile, sessionId }) => {
    const source = sessionIngestionSourceFromCorpus({
      agentId: "main",
      artifactKind: "active-session",
      sessionFile,
      sessionId,
      sessionKind: "interactive",
    });

    expect(source?.scope).toBe(`main:${sessionId}`);
    expect(source?.sessionOrigin).toEqual({ agentId: "main", sessionId });
  });

  it("verifies backfill content despite an unchanged size and mtime", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-ingestion-"));
    tempDirs.push(dir);
    const archiveFile = path.join(dir, "archive.jsonl");
    const record = (content: string) =>
      `${JSON.stringify({
        type: "message",
        id: "message-1",
        timestamp: "2026-04-05T18:00:00.000Z",
        message: {
          role: "user",
          content,
          timestamp: "2026-04-05T18:00:00.000Z",
        },
      })}\n`;
    const firstRaw = record("Alpha durable note.");
    const secondRaw = record("Bravo durable note.");
    expect(Buffer.byteLength(secondRaw)).toBe(Buffer.byteLength(firstRaw));
    const fixedTime = new Date("2026-04-06T00:00:00.000Z");
    await fs.writeFile(archiveFile, firstRaw);
    await fs.utimes(archiveFile, fixedTime, fixedTime);
    const source = foreignSessionIngestionSource("main", archiveFile);
    const first = await scanSessionIngestionSource({
      source,
      seenMessages: {},
      verifyContent: true,
      classifyDay: () => "include",
    });
    if (!first.fileState) {
      throw new Error("expected initial backfill checkpoint");
    }

    await fs.writeFile(archiveFile, secondRaw);
    await fs.utimes(archiveFile, fixedTime, fixedTime);
    const second = await scanSessionIngestionSource({
      source,
      previous: first.fileState,
      seenMessages: {},
      verifyContent: true,
      classifyDay: () => "include",
    });

    expect(second.candidates.map((candidate) => candidate.snippet)).toEqual([
      "User: Bravo durable note.",
    ]);
  });

  it.each([
    { maxCandidates: 1, expected: ["User: Bravo durable note.", "User: Charlie durable note."] },
    { maxCandidates: 2, expected: ["User: Charlie durable note."] },
  ])(
    "resumes an append after consuming $maxCandidates snapshot lines",
    async ({ maxCandidates, expected }) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-ingestion-"));
      tempDirs.push(dir);
      const archiveFile = path.join(dir, "archive.jsonl");
      const record = (id: string, content: string, timestamp: string) =>
        `${JSON.stringify({
          type: "message",
          id,
          timestamp,
          message: {
            role: "user",
            content,
            timestamp,
          },
        })}\n`;
      await fs.writeFile(
        archiveFile,
        record("message-1", "Alpha durable note.", "2026-04-06T06:59:59.000Z") +
          record("message-2", "Bravo durable note.", "2026-04-06T07:00:00.000Z"),
      );
      const source = foreignSessionIngestionSource("main", archiveFile);
      const classifiedDays: string[] = [];
      const classifyDay = (day: string) => {
        classifiedDays.push(day);
        return "include" as const;
      };
      const first = await scanSessionIngestionSource({
        source,
        seenMessages: {},
        verifyContent: true,
        maxCandidates,
        timezone: "America/Los_Angeles",
        classifyDay,
      });
      if (!first.fileState) {
        throw new Error("expected initial backfill checkpoint");
      }
      expect(first.candidates.map((candidate) => candidate.day)).toEqual(
        ["2026-04-05", "2026-04-06"].slice(0, maxCandidates),
      );
      expect(classifiedDays).toEqual(["2026-04-05", "2026-04-06"].slice(0, maxCandidates));

      classifiedDays.length = 0;
      const unchanged = await scanSessionIngestionSource({
        source,
        previous: first.fileState,
        seenMessages: {},
        verifyContent: true,
        timezone: "America/Los_Angeles",
        classifyDay,
      });
      expect(unchanged.candidates.map((candidate) => candidate.snippet)).toEqual(
        maxCandidates === 1 ? ["User: Bravo durable note."] : [],
      );
      expect(classifiedDays).toEqual(maxCandidates === 1 ? ["2026-04-06"] : []);

      await fs.appendFile(
        archiveFile,
        record("message-3", "Charlie durable note.", "2026-04-06T07:30:00.000Z"),
      );
      classifiedDays.length = 0;
      const second = await scanSessionIngestionSource({
        source,
        previous: first.fileState,
        seenMessages: {},
        verifyContent: true,
        timezone: "America/Los_Angeles",
        classifyDay,
      });

      expect(second.candidates.map(({ snippet, day }) => ({ snippet, day }))).toEqual(
        expected.map((snippet) => ({ snippet, day: "2026-04-06" })),
      );
      expect(classifiedDays).toEqual(
        maxCandidates === 1 ? ["2026-04-06", "2026-04-06"] : ["2026-04-06"],
      );
    },
  );

  it.each(["text", "timestamp", "provenance", "ordinal", "truncation"] as const)(
    "rescans when the previous snapshot changes by %s",
    async (change) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-ingestion-"));
      tempDirs.push(dir);
      const archiveFile = path.join(dir, "archive.jsonl");
      const record = (id: string, content: string) => ({
        type: "message",
        id,
        timestamp: "2026-04-05T18:00:00.000Z",
        message: { role: "user", content, timestamp: "2026-04-05T18:00:00.000Z" },
      });
      const firstRecord = record("message-1", "Alpha durable note.");
      const original = [firstRecord, record("message-2", "Bravo durable note.")];
      const writeRecords = (records: unknown[]) =>
        fs.writeFile(archiveFile, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      await writeRecords(original);
      const source = foreignSessionIngestionSource("main", archiveFile);
      const first = await scanSessionIngestionSource({
        source,
        seenMessages: {},
        verifyContent: true,
        classifyDay: () => "include",
      });
      if (!first.fileState) {
        throw new Error("expected initial transcript checkpoint");
      }
      let current: unknown[] = [...original, record("message-3", "Charlie durable note.")];
      if (change === "text") {
        current[0] = {
          ...firstRecord,
          message: { ...firstRecord.message, content: "Altered durable note." },
        };
      } else if (change === "timestamp") {
        current[0] = {
          ...firstRecord,
          message: { ...firstRecord.message, timestamp: "2026-04-05T18:01:00.000Z" },
        };
      } else if (change === "provenance") {
        source.buildOptions.sessionKind = "unknown";
      } else if (change === "ordinal") {
        current.unshift({ type: "custom", customType: "fixture-note", data: {} });
      } else {
        current = [firstRecord];
      }
      await writeRecords(current);
      const changed = await scanSessionIngestionSource({
        source,
        previous: first.fileState,
        seenMessages: {},
        verifyContent: true,
        classifyDay: () => "include",
      });
      expect(changed.candidates.map((candidate) => candidate.snippet)).toEqual(
        change === "truncation"
          ? ["User: Alpha durable note."]
          : [
              change === "text" ? "User: Altered durable note." : "User: Alpha durable note.",
              "User: Bravo durable note.",
              "User: Charlie durable note.",
            ],
      );
    },
  );
});
