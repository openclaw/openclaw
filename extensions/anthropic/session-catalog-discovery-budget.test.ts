import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import {
  listClaudeSessionCatalog,
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog-listing.js";
import { CLAUDE_SESSIONS_LIST_COMMAND } from "./session-catalog-shared.js";
import { createClaudeCatalogWatchDriver } from "./session-catalog-watch.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function userLine(sessionId: string, isSidechain = false) {
  return JSON.stringify({
    type: "user",
    sessionId,
    uuid: `${sessionId}-1`,
    entrypoint: "sdk-cli",
    isSidechain,
    message: { role: "user", content: sessionId },
  });
}

describe("Claude session catalog discovery budget", () => {
  it("reports the discovery frontier and finds and reads an exact ID beyond it", async () => {
    const home = tempDirs.make("openclaw-catalog-budget-");
    const watches = createClaudeCatalogWatchDriver(home);
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    await fs.mkdir(projectDir, { recursive: true });
    // Each transcript consumes one MiB before its first user record.
    const transcript = Buffer.alloc(1024 * 1024, `${"x".repeat(16 * 1024 - 1)}\n`);
    for (let index = 0; index < 66; index += 1) {
      const sessionId = `budget-${String(index).padStart(2, "0")}`;
      const line = `\n${userLine(sessionId)}\n`;
      transcript.write(line, transcript.length - Buffer.byteLength(line));
      await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), transcript);
    }
    const targetId = (await fs.readdir(projectDir)).at(-1)!.slice(0, -".jsonl".length);
    const options = { includeDesktop: false };
    const first = await listLocalClaudeSessionPage({ limit: 50 }, home, options);
    watches.arm();
    expect(first.nextCursor).toBeDefined();
    expect(first.error).toBeUndefined();
    const last = await listLocalClaudeSessionPage({ cursor: first.nextCursor }, home, options);
    expect([...first.sessions, ...last.sessions].map((session) => session.threadId)).not.toContain(
      targetId,
    );
    expect(last.nextCursor).toBeUndefined();
    expect(last.error?.code).toBe("DISCOVERY_TRUNCATED");

    const open = vi.spyOn(fs, "open");
    const read = await readLocalClaudeTranscriptPage(
      { threadId: targetId, limit: 1 },
      home,
      options,
    );
    expect(read.items).toMatchObject([{ text: targetId }]);
    expect(open.mock.calls.map(([file]) => file)).toEqual([
      path.join(projectDir, `${targetId}.jsonl`),
      path.join(projectDir, `${targetId}.jsonl`),
    ]);
    const exact = await listLocalClaudeSessionPage(
      { searchTerm: targetId.toUpperCase() },
      home,
      options,
    );
    expect(exact.sessions.map((session) => session.threadId)).toEqual([targetId]);
    const missing = await listLocalClaudeSessionPage(
      { searchTerm: "missing-session" },
      home,
      options,
    );
    expect(missing.sessions).toEqual([]);
    expect(missing.error?.code).toBe("DISCOVERY_TRUNCATED");
    expect(await listLocalClaudeSessionPage({ cursor: first.nextCursor }, home, options)).toEqual(
      last,
    );

    const runtime = createPluginRuntimeMock();
    runtime.nodes.list = vi.fn(async () => ({
      nodes: [{ nodeId: "paired", connected: true, commands: [CLAUDE_SESSIONS_LIST_COMMAND] }],
    }));
    runtime.nodes.invoke = vi.fn(async ({ params }) => ({
      payloadJSON: JSON.stringify(await listLocalClaudeSessionPage(params, home, options)),
    }));
    const remote = await listClaudeSessionCatalog({
      runtime,
      query: { hostIds: ["node:paired"], cursors: { "node:paired": first.nextCursor } },
    });
    expect(remote.hosts[0]?.error?.code).toBe("DISCOVERY_TRUNCATED");
    expect(remote.hosts[0]?.sessions).toEqual(last.sessions);
  });

  it("keeps indexed and transcript sidechains out of exact lookup", async () => {
    const home = tempDirs.make("openclaw-catalog-exact-");
    createClaudeCatalogWatchDriver(home);
    const projectDir = path.join(home, ".claude", "projects", "-workspace");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "indexed.jsonl"), userLine("indexed"));
    await fs.writeFile(path.join(projectDir, "sidechain.jsonl"), userLine("sidechain", true));
    await fs.writeFile(path.join(projectDir, "visible.jsonl"), userLine("visible"));
    await fs.writeFile(
      path.join(projectDir, "sessions-index.json"),
      JSON.stringify({
        entries: [{ sessionId: "indexed", isSidechain: true }],
      }),
    );
    for (const sessionId of ["indexed", "sidechain", "visible"]) {
      const scan = await listClaudeSessions(home, { sessionId, includeDesktop: false });
      expect(scan.records.map((record) => record.threadId)).toEqual(
        sessionId === "visible" ? ["visible"] : [],
      );
      expect(scan.truncated).toBe(false);
    }
  });
});
