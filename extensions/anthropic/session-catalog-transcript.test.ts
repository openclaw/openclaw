import fs from "node:fs/promises";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { message, projectFile, writeProject } from "./session-catalog-fixtures.test-support.js";
import { readLocalClaudeTranscriptPage } from "./session-catalog-listing.js";

afterEach(() => {
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeLongPagedTranscript(params: {
  home: string;
  sessionId: string;
  truncated?: boolean;
}): Promise<string> {
  const oldUser = "old user ".repeat(20_000);
  await writeProject({
    home: params.home,
    entries: [
      {
        sessionId: params.sessionId,
        fullPath: projectFile(params.home, `${params.sessionId}.jsonl`),
        summary: "Transcript",
        modified: "2026-07-04T00:00:00.000Z",
        isSidechain: false,
      },
    ],
    transcripts: {
      [params.sessionId]: params.truncated
        ? [
            message(params.sessionId, "user", oldUser, 1),
            message(params.sessionId, "assistant", "new assistant", 2),
          ]
        : [
            { type: "queue-operation", sessionId: params.sessionId },
            message(params.sessionId, "user", oldUser, 1),
            message(params.sessionId, "assistant", "old assistant", 2),
            message(params.sessionId, "user", "new user", 3),
            message(params.sessionId, "assistant", "new assistant", 4),
          ],
    },
  });
  return oldUser;
}

// Cap positional reads on one transcript; a zero cap simulates mid-window EOF.
function injectTranscriptShortReads(
  sessionId: string,
  plan: (input: {
    length: number;
    position: number;
    call: number;
    firstPosition: number;
  }) => number,
): void {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const [target] = args;
    if (typeof target === "string" && target.endsWith(`${sessionId}.jsonl`)) {
      const realRead = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      let call = 0;
      let firstPosition = -1;
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: (buffer: Buffer, offset: number, length: number, position: number) => {
          if (firstPosition < 0) {
            firstPosition = position;
          }
          const allowed = plan({ length, position, call, firstPosition });
          call += 1;
          return realRead(buffer, offset, allowed, position);
        },
      });
    }
    return handle;
  });
}

describe("Claude transcript pagination", () => {
  it("pages transcripts identically when every reverse-scan read returns short", async () => {
    const home = tempDirs.make("openclaw-claude-transcript-");
    const sessionId = "short-read-session";
    const oldUser = await writeLongPagedTranscript({ home, sessionId });

    // The fixture spans multiple 128 KiB windows; each is filled in 4 KiB reads.
    injectTranscriptShortReads(sessionId, ({ length }) => Math.min(length, 4096));

    const latest = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home);
    expect(latest.items.map((item) => item.text)).toEqual(["new assistant", "new user"]);
    expect(latest.nextCursor).toEqual(expect.any(String));
    if (!latest.nextCursor) {
      throw new Error("expected transcript cursor");
    }

    const older = await readLocalClaudeTranscriptPage(
      { threadId: sessionId, limit: 2, cursor: latest.nextCursor },
      home,
    );
    expect(older.items.map((item) => item.text)).toEqual(["old assistant", oldUser]);
    expect(older.nextCursor).toBeUndefined();
    const transcriptCursorPayload = JSON.parse(
      Buffer.from(latest.nextCursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const nonEmittedTranscriptCursor = Buffer.from(
      JSON.stringify({ ...transcriptCursorPayload, extra: true }),
      "utf8",
    ).toString("base64url");
    for (const cursor of [
      `${latest.nextCursor}!`,
      `${latest.nextCursor}=`,
      ` ${latest.nextCursor} `,
      nonEmittedTranscriptCursor,
      " ",
      null,
    ]) {
      await expect(
        readLocalClaudeTranscriptPage({ threadId: sessionId, cursor, limit: 1 }, home),
      ).rejects.toThrow("transcript cursor is invalid");
    }
  });

  it("still reports a truncated transcript when a reverse-scan read hits EOF mid-window", async () => {
    const home = tempDirs.make("openclaw-claude-transcript-");
    const sessionId = "truncated-read-session";
    await writeLongPagedTranscript({ home, sessionId, truncated: true });

    // Return one partial reverse read, then simulate truncation with zero bytes.
    injectTranscriptShortReads(sessionId, ({ length, call, firstPosition }) =>
      firstPosition === 0 ? length : call === 0 ? Math.min(length, 8) : 0,
    );

    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home),
    ).rejects.toThrow("Claude transcript changed while it was being read");
  });
});
