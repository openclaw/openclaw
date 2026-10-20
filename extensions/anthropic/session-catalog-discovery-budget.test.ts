import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import {
  listClaudeSessionCatalog as catalog,
  listLocalClaudeSessionPage as list,
  readLocalClaudeTranscriptPage as read,
} from "./session-catalog-listing.js";
import { CLAUDE_SESSIONS_LIST_COMMAND } from "./session-catalog-shared.js";
import { createClaudeCatalogWatchDriver } from "./session-catalog-watch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const local = { includeDesktop: false };
afterEach(() => vi.restoreAllMocks());
let home: string;
let dir: string;
let watches: ReturnType<typeof createClaudeCatalogWatchDriver>;
beforeEach(async () => {
  home = tempDirs.make("openclaw-catalog-budget-");
  watches = createClaudeCatalogWatchDriver(home);
  dir = path.join(home, ".claude", "projects", "-workspace");
  await fs.mkdir(dir, { recursive: true });
});
const write = (name: string, data: string | Buffer) => fs.writeFile(path.join(dir, name), data);
const page = (query: Parameters<typeof list>[0]) => list(query, home, local);

function userLine(sessionId: string, isSidechain = false) {
  return JSON.stringify({
    type: "user",
    sessionId,
    entrypoint: "sdk-cli",
    isSidechain,
    message: { role: "user", content: sessionId },
  });
}

describe("Claude session catalog discovery budget", () => {
  it("reports the discovery frontier and finds and reads an exact ID beyond it", async () => {
    // Each transcript consumes one MiB before its first user record.
    const transcript = Buffer.alloc(1024 * 1024, `${"x".repeat(16 * 1024 - 1)}\n`);
    for (let index = 0; index < 66; index += 1) {
      const sessionId = `budget-${String(index).padStart(2, "0")}`;
      const line = `\n${userLine(sessionId)}\n`;
      transcript.write(line, transcript.length - Buffer.byteLength(line));
      await write(`${sessionId}.jsonl`, transcript);
    }
    const targetId = (await fs.readdir(dir)).at(-1)!.slice(0, -".jsonl".length);
    const first = await page({ limit: 50 });
    watches.arm();
    expect(first.nextCursor).toBeDefined();
    expect(first.error).toBeUndefined();
    const last = await page({ cursor: first.nextCursor });
    const discovered = [...first.sessions, ...last.sessions].map((session) => session.threadId);
    expect(discovered).not.toContain(targetId);
    expect(last.nextCursor).toBeUndefined();
    expect(last.error?.code).toBe("DISCOVERY_TRUNCATED");

    const open = vi.spyOn(fs, "open");
    const transcriptPage = await read({ threadId: targetId, limit: 1 }, home, local);
    expect(transcriptPage.items).toMatchObject([{ text: targetId }]);
    const targetFile = path.join(dir, `${targetId}.jsonl`);
    expect(open.mock.calls.map(([file]) => file)).toEqual([targetFile, targetFile]);
    const exact = await page({ searchTerm: targetId.toUpperCase() });
    expect(exact.sessions.map((session) => session.threadId)).toEqual([targetId]);
    expect(await page({ searchTerm: "missing-session" })).toMatchObject({
      sessions: [],
      error: { code: "DISCOVERY_TRUNCATED" },
    });
    expect(await page({ cursor: first.nextCursor })).toEqual(last);

    const runtime = createPluginRuntimeMock();
    runtime.nodes.list = vi.fn(async () => ({
      nodes: [{ nodeId: "paired", connected: true, commands: [CLAUDE_SESSIONS_LIST_COMMAND] }],
    }));
    runtime.nodes.invoke = vi.fn(async ({ params }) => ({
      payloadJSON: JSON.stringify(await page(params)),
    }));
    const remote = await catalog({
      runtime,
      query: { hostIds: ["node:paired"], cursors: { "node:paired": first.nextCursor } },
    });
    expect(remote.hosts[0]?.error?.code).toBe("DISCOVERY_TRUNCATED");
    expect(remote.hosts[0]?.sessions).toEqual(last.sessions);
  });

  it("keeps indexed and transcript sidechains out of exact lookup", async () => {
    for (const id of ["indexed", "sidechain", "visible"]) {
      await write(`${id}.jsonl`, userLine(id, id === "sidechain"));
    }
    const index = { entries: [{ sessionId: "indexed", isSidechain: true }] };
    await write("sessions-index.json", JSON.stringify(index));
    for (const sessionId of ["indexed", "sidechain", "visible"]) {
      const scan = await listClaudeSessions(home, { sessionId, includeDesktop: false });
      expect(scan.records.map((record) => record.threadId)).toEqual(
        sessionId === "visible" ? ["visible"] : [],
      );
      expect(scan.truncated).toBe(false);
    }
  });
});
