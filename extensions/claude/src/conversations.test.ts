import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordClaudeThreadTurnSummary,
  writeClaudeAppServerBinding,
} from "./app-server/thread-store.js";
import {
  buildConversationRows,
  type ConversationSessionEntry,
  formatConversationsList,
  isConversationSessionKey,
} from "./command-handlers.js";

describe("isConversationSessionKey", () => {
  it("treats direct and channel sessions as real conversations", () => {
    expect(isConversationSessionKey("agent:tank:direct:eddie")).toBe(true);
    expect(isConversationSessionKey("agent:tank:discord:channel:12345")).toBe(true);
    expect(isConversationSessionKey("agent:main:slack:channel:c0b2eddpw95")).toBe(true);
  });

  it("excludes subagent, cron, and heartbeat sessions", () => {
    expect(isConversationSessionKey("agent:tank:subagent:9b13027d-...")).toBe(false);
    expect(isConversationSessionKey("agent:tank:cron:82c35b10-...")).toBe(false);
    expect(isConversationSessionKey("agent:tank:slack:channel:c0b2eddpw95:heartbeat")).toBe(false);
  });
});

describe("buildConversationRows", () => {
  it("skips entries with no sessionId or that aren't real conversations, but counts real-key candidates even without a binding", async () => {
    const entries: ConversationSessionEntry[] = [
      { sessionKey: "agent:tank:direct:eddie", entry: {} }, // no sessionId
      {
        sessionKey: "agent:tank:direct:someone",
        entry: { sessionId: "s1" }, // real key, no binding sidecar (readBinding returns null below)
      },
      {
        sessionKey: "agent:tank:subagent:xyz",
        entry: { sessionId: "s2" }, // automation key, excluded regardless of sessionId
      },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      resolveSessionFile: () => "/tmp/whatever.jsonl",
      readBinding: async () => null,
    });
    expect(rows).toHaveLength(0);
    // Only "someone" is a real-key candidate with a sessionId; "eddie" lacks a
    // sessionId and "xyz" is filtered by key before ever counting.
    expect(candidateCount).toBe(1);
  });

  it("resolves a binding for a qualifying entry via the injected deps, regardless of cliSessionBindings", async () => {
    const binding = {
      schemaVersion: 1,
      threadId: "thr_abc",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 2,
    };
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:direct:eddie",
        entry: { sessionId: "s1", origin: { label: "eddie" } },
      },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      resolveSessionFile: () => "/tmp/session.jsonl",
      readBinding: async (file) => (file === "/tmp/session.jsonl" ? binding : null),
    });
    expect(candidateCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("eddie");
    expect(rows[0]?.binding.threadId).toBe("thr_abc");
  });

  it("finds a real conversation whose binding sidecar predates any core-session-store provider marker (the real bug this fixed)", async () => {
    // Confirmed against real production data: a session last touched
    // 2026-06-29 had a real, readable .claude-binding.json sidecar but no
    // cliSessionBindings/cliSessionIds entry on its core session record at
    // all (that marker is only written by openclaw-pg9-era turns). Gating on
    // the marker silently hid it from /claude conversations.
    const binding = {
      schemaVersion: 1,
      threadId: "thr_predates_marker",
      cwd: "/tmp",
      createdAt: 1,
      updatedAt: 2,
    };
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:discord:tank:direct:159471966640799744",
        entry: { sessionId: "old-session-id" }, // no cliSessionBindings/cliSessionIds at all
      },
    ];
    const { rows } = await buildConversationRows(entries, {
      resolveSessionFile: () => "/tmp/old-session.jsonl",
      readBinding: async (file) => (file === "/tmp/old-session.jsonl" ? binding : null),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.binding.threadId).toBe("thr_predates_marker");
  });

  it("skips a candidate entry when no binding sidecar exists yet", async () => {
    const entries: ConversationSessionEntry[] = [
      { sessionKey: "agent:tank:direct:eddie", entry: { sessionId: "s1" } },
    ];
    const { rows, candidateCount } = await buildConversationRows(entries, {
      resolveSessionFile: () => "/tmp/session.jsonl",
      readBinding: async () => null,
    });
    expect(candidateCount).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

describe("formatConversationsList", () => {
  it("reports no-candidates vs no-bindings-yet distinctly when empty", () => {
    expect(formatConversationsList([], 0)).toContain("No other real conversation sessions found");
    expect(formatConversationsList([], 3)).toContain("none have a claude-binding sidecar yet");
  });

  it("sorts by updatedAt descending and renders summary fields", () => {
    const rows = [
      {
        label: "older",
        sessionKey: "agent:tank:direct:a",
        binding: {
          schemaVersion: 1,
          threadId: "thr_old",
          cwd: "/tmp",
          model: "claude-sonnet-5",
          modelProvider: "anthropic",
          createdAt: 1,
          updatedAt: 1000,
          turnCount: 2,
          lastAssistantPreview: "an old reply",
        },
      },
      {
        label: "newer",
        sessionKey: "agent:tank:direct:b",
        binding: {
          schemaVersion: 1,
          threadId: "thr_new",
          cwd: "/tmp",
          model: "glm-5.2",
          modelProvider: "zai",
          createdAt: 1,
          updatedAt: 2000,
          turnCount: 5,
          lastAssistantPreview: "a newer reply",
        },
      },
    ];
    const text = formatConversationsList(rows, 2);
    const newerIdx = text.indexOf("newer");
    const olderIdx = text.indexOf("older");
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThan(newerIdx);
    expect(text).toContain("thr_new");
    expect(text).toContain("glm-5.2 (zai)");
    expect(text).toContain("a newer reply");
    expect(text).toContain("Turns: 5");
  });

  it("notes how many rows were truncated beyond the display limit", () => {
    const rows = Array.from({ length: 17 }, (_, i) => ({
      label: `conv-${i}`,
      sessionKey: `agent:tank:direct:${i}`,
      binding: {
        schemaVersion: 1,
        threadId: `thr_${i}`,
        cwd: "/tmp",
        createdAt: 1,
        updatedAt: i,
      },
    }));
    const text = formatConversationsList(rows, 17);
    expect(text).toContain("Showing 15 of 17");
    expect(text).toContain("2 more not shown");
  });
});

describe("handleConversations end-to-end against a real binding sidecar", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "claude-conversations-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("readBinding + buildConversationRows round-trip a real sidecar written via writeClaudeAppServerBinding", async () => {
    const sessionFile = path.join(dir, "session.jsonl");
    await writeClaudeAppServerBinding(sessionFile, {
      threadId: "thr_real",
      cwd: dir,
      model: "claude-sonnet-5",
      modelProvider: "anthropic",
    });
    await recordClaudeThreadTurnSummary(sessionFile, {
      stopReason: "stop",
      assistantPreview: "hi from a real sidecar",
    });
    const entries: ConversationSessionEntry[] = [
      {
        sessionKey: "agent:tank:direct:eddie",
        entry: {
          sessionId: "real-session-id",
          origin: { label: "eddie (real)" },
        },
      },
    ];
    const { readClaudeAppServerBinding } = await import("./app-server/thread-store.js");
    const { rows, candidateCount } = await buildConversationRows(entries, {
      resolveSessionFile: () => sessionFile,
      readBinding: readClaudeAppServerBinding,
    });
    expect(candidateCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.binding.lastAssistantPreview).toBe("hi from a real sidecar");
    const text = formatConversationsList(rows, candidateCount);
    expect(text).toContain("eddie (real)");
    expect(text).toContain("hi from a real sidecar");
  });
});
