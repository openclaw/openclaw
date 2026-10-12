import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  foreignSessionIngestionSource,
  scanSessionIngestionSource,
  sessionIngestionSourceFromCorpus,
} from "./session-ingestion.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session ingestion", () => {
  it.each(["unknown"] as const)("excludes %s sessions from memory ingestion", (sessionKind) => {
    expect(
      sessionIngestionSourceFromCorpus(
        {
          agentId: "main",
          artifactKind: "active-session",
          transcriptSource: "sqlite",
          sessionFile: "synthetic-session",
          sessionId: "synthetic-session",
          sessionKind,
        },
        "backfill",
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "session id ending in .jsonl",
      sessionFile: path.join(os.tmpdir(), "foo.jsonl.jsonl"),
      sessionId: "foo.jsonl",
    },
  ])("preserves file-backed scope identity for $name", ({ sessionFile, sessionId }) => {
    const source = sessionIngestionSourceFromCorpus(
      {
        agentId: "main",
        artifactKind: "active-session",
        sessionFile,
        sessionId,
        sessionKind: "interactive",
      },
      "backfill",
    );

    expect(source?.scope).toBe(`main:${sessionId}`);
    expect(source?.sessionOrigin).toEqual({ agentId: "main", sessionId });
  });

  it.each([
    { maxCandidates: 1, expected: ["User: Bravo durable note.", "User: Charlie durable note."] },
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
});
