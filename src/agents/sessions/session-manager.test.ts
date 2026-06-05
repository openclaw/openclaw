import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSessionManagerForRun } from "../embedded-agent-runner/session-manager-init.js";
import {
  CURRENT_SESSION_VERSION,
  loadEntriesFromFile,
  SessionManager,
  type SessionEntry,
} from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-"));
  tempPaths.push(dir);
  return dir;
}

describe("SessionManager.open", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("recovers a corrupted first-line header without truncating later messages", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const originalHeader = {
      type: "session",
      version: 3,
      id: "original-session",
      timestamp: "2026-05-27T00:00:00.000Z",
      cwd: "/srv/openclaw/main",
    };
    const userEntry = {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-05-27T00:00:01.000Z",
      message: { role: "user", content: "important question" },
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-05-27T00:00:02.000Z",
      message: { role: "assistant", content: "important answer" },
    };
    const originalTranscript =
      [
        JSON.stringify(originalHeader).slice(0, 30),
        JSON.stringify(userEntry),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n";
    await fs.writeFile(sessionFile, originalTranscript, "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(sessionFile, 0o600);
    }

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");

    expect(sessionManager.getEntries()).toEqual([userEntry, assistantEntry]);
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important question");
    expect(await fs.readFile(sessionFile, "utf8")).toContain("important answer");
    await expect(fs.readFile(sessionFile, "utf8")).resolves.not.toBe(originalTranscript);

    const backupFiles = (await fs.readdir(dir)).filter((file) => file.includes(".corrupt-"));
    expect(backupFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(dir, backupFiles[0] ?? ""), "utf8")).resolves.toBe(
      originalTranscript,
    );
    if (process.platform !== "win32") {
      const backupStat = await fs.stat(path.join(dir, backupFiles[0] ?? ""));
      expect(backupStat.mode & 0o777).toBe(0o600);
    }
  });

  it("does not duplicate the header after recovering a header-only corrupt file", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session","version":3,"id":"sess', "utf8");

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/task-repo");
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      api: "messages",
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const entries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });

    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
  });

  it("still migrates old transcript versions while bypassing the warm cache", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const legacyHeader = {
      type: "session",
      version: 2,
      id: "legacy-session",
      timestamp: "2026-06-04T00:00:00.000Z",
      cwd: dir,
    };
    const legacyEntry = {
      type: "message",
      id: "legacy-entry",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: {
        role: "hookMessage",
        content: "legacy hook content",
      },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(legacyHeader)}\n${JSON.stringify(legacyEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);

    expect(sessionManager.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
    expect(sessionManager.getEntries()).toEqual([
      {
        ...legacyEntry,
        message: { ...legacyEntry.message, role: "custom" },
      },
    ]);
    const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; version?: number; message?: unknown });
    expect(persistedEntries[0]).toMatchObject({
      type: "session",
      version: CURRENT_SESSION_VERSION,
    });
    expect(persistedEntries[1]).toMatchObject({
      type: "message",
      message: { role: "custom" },
    });
  });

  it("reuses current transcript entries across warm opens and appends without stale readback", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const secondMessage = buildAssistantMessage("message 2");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      expect(loadEntriesFromFile(sessionFile).map((entry) => entry.type)).toEqual([
        "session",
        "message",
      ]);
      expect(parseCount).toBe(2);

      parseCount = 0;
      expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
      expect(parseCount).toBe(0);

      const sessionManager = SessionManager.open(sessionFile, dir, dir);
      sessionManager.appendMessage(secondMessage);
      const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => originalParse(line) as { type: string });
      expect(persistedEntries.map((entry) => entry.type)).toEqual([
        "session",
        "message",
        "message",
      ]);

      parseCount = 0;
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
        "message 2",
      ]);
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("invalidates the transcript entry cache when the file is externally replaced", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const replacementEntry = buildMessageEntry(2, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    expect(SessionManager.open(sessionFile, dir, dir).getEntries()).toEqual([firstEntry]);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "replacement-session"))}\n${JSON.stringify(
        replacementEntry,
      )}\n`,
      "utf8",
    );

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getSessionId()).toBe("replacement-session");
      expect(reopened.getEntries()).toEqual([replacementEntry]);
      expect(parseCount).toBeGreaterThanOrEqual(2);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("does not persist caller-side entry mutations into warm cache hits", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const opened = SessionManager.open(sessionFile, dir, dir);
    const returnedEntry = opened.getEntries()[0];
    if (!returnedEntry || returnedEntry.type !== "message") {
      throw new Error("expected message entry");
    }
    expect(() => {
      (returnedEntry.message as { content: unknown }).content = "mutated only in caller";
    }).toThrow(TypeError);

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
      ]);
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("invalidates the warm cache when another writer appends before this manager persists", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const firstEntry = buildMessageEntry(1, null);
    const externalEntry = buildMessageEntry(2, firstEntry.id);
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir))}\n${JSON.stringify(firstEntry)}\n`,
      "utf8",
    );

    const sessionManager = SessionManager.open(sessionFile, dir, dir);
    await fs.appendFile(sessionFile, `${JSON.stringify(externalEntry)}\n`, "utf8");
    sessionManager.appendMessage(buildAssistantMessage("message 3"));

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      const reopened = SessionManager.open(sessionFile, dir, dir);
      expect(reopened.getEntries().map((entry) => readMessageContent(entry))).toEqual([
        "message 1",
        "message 2",
        "message 3",
      ]);
      expect(parseCount).toBeGreaterThanOrEqual(4);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it("lets prepareSessionManagerForRun normalize a warm-cached header without re-parsing", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const assistantEntry = {
      type: "message",
      id: "assistant-1",
      parentId: null,
      timestamp: "2026-06-04T00:00:01.000Z",
      message: { role: "assistant", content: "carried context" },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(buildSessionHeader(dir, "original-session"))}\n${JSON.stringify(
        assistantEntry,
      )}\n`,
      "utf8",
    );

    // Warm the process-level entry cache.
    expect(SessionManager.open(sessionFile, dir, dir).getSessionId()).toBe("original-session");

    const originalParse = JSON.parse;
    let parseCount = 0;
    JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
      parseCount += 1;
      return originalParse.apply(originalParse, args);
    } as typeof JSON.parse;

    try {
      // Two warm hits off the same cache entry: must not re-parse the transcript.
      const sessionManager = SessionManager.open(sessionFile, dir, dir);
      const sibling = SessionManager.open(sessionFile, dir, dir);
      expect(parseCount).toBe(0);

      // The embedded runner normalizes the loaded header in place. With a shared
      // frozen cache entry this threw "Cannot assign to read only property".
      await expect(
        prepareSessionManagerForRun({
          sessionManager,
          sessionFile,
          hadSessionFile: true,
          sessionId: "run-session",
          cwd: "/tmp/task-repo",
        }),
      ).resolves.toBeUndefined();

      expect(sessionManager.getSessionId()).toBe("run-session");
      expect(sessionManager.getHeader()).toEqual(
        expect.objectContaining({ type: "session", id: "run-session", cwd: "/tmp/task-repo" }),
      );
      expect(sessionManager.getCwd()).toBe("/tmp/task-repo");

      // Each warm hit gets an independent mutable header clone, so normalizing
      // one manager's header must not bleed into the cached snapshot shared with
      // the sibling manager.
      expect(sibling.getHeader()).toEqual(
        expect.objectContaining({ type: "session", id: "original-session", cwd: dir }),
      );

      // Header normalization stayed in memory; the warm hits never re-parsed.
      expect(parseCount).toBe(0);
    } finally {
      JSON.parse = originalParse;
    }
  });
});

function readMessageContent(entry: SessionEntry): unknown {
  const content = (entry as { message: { content: unknown } }).message.content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? "").join("");
  }
  return content;
}

function buildAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function buildSessionHeader(cwd: string, id = "test-session") {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp: "2026-06-04T00:00:00.000Z",
    cwd,
  };
}

function buildMessageEntry(index: number, parentId: string | null): SessionEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId,
    timestamp: `2026-06-04T00:00:0${index}.000Z`,
    message: { role: "user", content: `message ${index}`, timestamp: index },
  };
}
