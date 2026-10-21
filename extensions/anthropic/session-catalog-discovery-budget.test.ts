import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
beforeEach(async () => {
  home = tempDirs.make("openclaw-catalog-budget-");
  dir = path.join(home, ".claude", "projects", "-workspace");
  await fs.mkdir(dir, { recursive: true });
});
const write = (name: string, data: string | Buffer) => fs.writeFile(path.join(dir, name), data);
const page = (query: Parameters<typeof list>[0]) => list(query, home, local);

const userLine = (sessionId: string, isSidechain = false) =>
  JSON.stringify({
    type: "user",
    sessionId,
    entrypoint: "sdk-cli",
    isSidechain,
    message: { role: "user", content: sessionId },
  });

it("reports the discovery frontier and finds and reads an exact ID beyond it", async () => {
  const watches = createClaudeCatalogWatchDriver(home);
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
  expect([first.nextCursor, first.error]).toEqual([expect.any(String), undefined]);
  const last = await page({ cursor: first.nextCursor });
  expect([...first.sessions, ...last.sessions].map((session) => session.threadId)).not.toContain(
    targetId,
  );
  expect([last.nextCursor, last.error?.code]).toEqual([undefined, "DISCOVERY_TRUNCATED"]);

  const open = vi.spyOn(fs, "open");
  const transcriptPage = await read({ threadId: targetId, limit: 1 }, home, local);
  expect(transcriptPage.items).toMatchObject([{ text: targetId }]);
  expect(open.mock.calls.map(([file]) => file)).toEqual(
    Array<string>(2).fill(path.join(dir, `${targetId}.jsonl`)),
  );
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
  expect([remote.hosts[0]?.error?.code, remote.hosts[0]?.sessions]).toEqual([
    "DISCOVERY_TRUNCATED",
    last.sessions,
  ]);
});

it("keeps indexed and transcript sidechains out of exact lookup", async () => {
  createClaudeCatalogWatchDriver(home);
  for (const id of ["indexed", "sidechain", "visible"]) {
    await write(`${id}.jsonl`, userLine(id, id === "sidechain"));
  }
  await write("sessions-index.json", '{"entries":[{"sessionId":"indexed","isSidechain":true}]}');
  for (const sessionId of ["indexed", "sidechain", "visible"]) {
    const scan = await listClaudeSessions(home, { sessionId, includeDesktop: false });
    expect(scan.records.map((record) => record.threadId)).toEqual(
      sessionId === "visible" ? ["visible"] : [],
    );
    expect(scan.truncated).toBe(false);
  }
});
