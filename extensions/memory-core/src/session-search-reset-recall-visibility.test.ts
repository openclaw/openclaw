import * as engineSessions from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import {
  searchHit,
  sessionEntry,
  type TestSessionEntry,
} from "./session-search-visibility.test-support.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

let combinedSessionStore: Record<string, TestSessionEntry> = {};
const anchorSessionKey = "agent:main:telegram:direct:owner";
const directEntry = (id: string, updatedAt: number) =>
  sessionEntry(id, updatedAt, `/tmp/sessions/${id}.jsonl`, { chatType: "direct" });
const archiveRecord = (archiveName: string, sessionId: string) => ({
  agentId: "main",
  archiveName,
  sessionId,
  sessionKey: anchorSessionKey,
  createdAt: 1,
});

function filter(
  hits: MemorySearchResult[],
  overrides: Partial<Parameters<typeof filterMemorySearchHitsBySessionVisibility>[0]> = {},
) {
  return filterMemorySearchHitsBySessionVisibility({
    cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
    agentId: "main",
    requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
    sandboxed: false,
    hits,
    conversationRecall: { anchorSessionKey, scope: "same-agent-private", corpus: "sessions" },
    ...overrides,
  });
}

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-sessions")>();
  return {
    ...actual,
    readSessionResetRecallCutoff: vi.fn(async () => ({ state: "absent" })),
    loadArchivedSessionsAsync: vi.fn(async () => []),
  };
});

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayAsync: vi.fn(async () => ({
      storePath: "(test)",
      store: combinedSessionStore,
    })),
  };
});

describe("reset-generation session search visibility", () => {
  beforeEach(() => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 2),
    };
  });
  afterEach(() => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGatewayAsync).mockClear();
    vi.mocked(engineSessions.readSessionResetRecallCutoff)
      .mockReset()
      .mockResolvedValue({ state: "absent" });
    vi.mocked(engineSessions.loadArchivedSessionsAsync).mockReset().mockResolvedValue([]);
    combinedSessionStore = {};
  });

  it("resolves bounded archive filenames through canonical SQLite identity", async () => {
    const archivedSessionId = `oversized-${"x".repeat(300)}`;
    const archiveName = `session-${"a".repeat(64)}.jsonl.reset.2026-08-11T08-00-00.000Z.zst`;
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current-after-reset", 2),
    };
    vi.mocked(engineSessions.loadArchivedSessionsAsync).mockResolvedValue([
      archiveRecord(archiveName, archivedSessionId),
    ]);
    const hit = searchHit(`sessions/main/${archiveName}`, "sessions", "retained context");

    await expect(
      filter([hit], {
        cfg: asOpenClawConfig({
          session: { store: "/tmp/memory-search-archive-test/sessions.json" },
          tools: { sessions: { visibility: "self" } },
        }),
        requesterSessionKey: anchorSessionKey,
        conversationRecall: undefined,
      }),
    ).resolves.toEqual([hit]);
    expect(engineSessions.loadArchivedSessionsAsync).toHaveBeenCalledWith({
      agentId: "main",
      archiveNames: [archiveName],
      storePath: "/tmp/memory-search-archive-test/sessions.json",
    });
  });

  it("rechecks private conversation metadata after awaiting archive inventory", async () => {
    const archiveName = "previous.jsonl.reset.2026-08-11T08-00-00.000Z";
    combinedSessionStore = {
      [anchorSessionKey]: sessionEntry("current", 2, "/tmp/current.jsonl", { chatType: "direct" }),
    };
    vi.mocked(engineSessions.loadArchivedSessionsAsync).mockImplementationOnce(async () => {
      combinedSessionStore = {
        [anchorSessionKey]: sessionEntry("current", 3, "/tmp/current.jsonl", { chatType: "group" }),
      };
      return [archiveRecord(archiveName, "previous")];
    });
    await expect(
      filter([searchHit(`sessions/main/${archiveName}`, "sessions", "private context")], {
        requesterSessionKey: anchorSessionKey,
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    { name: "crossing", range: [3, 4], cutoff: { state: "valid", cutoffLine: 4 } },
    { name: "read-failure", range: [1, 2], cutoff: undefined },
  ] as const)("handles a $name live SQLite reset-generation hit", async ({ range, cutoff }) => {
    if (cutoff === undefined) {
      vi.mocked(engineSessions.readSessionResetRecallCutoff).mockRejectedValue(
        new Error("read failed"),
      );
    } else {
      vi.mocked(engineSessions.readSessionResetRecallCutoff).mockResolvedValue(cutoff);
    }
    const hit = searchHit("sessions/main/current.jsonl", "sessions", "short fact", {
      startLine: range[0],
      endLine: range[1],
    });

    await expect(filter([hit])).resolves.toEqual([]);
  });

  it("resolves the live anchor reset cutoff once per filter pass", async () => {
    vi.mocked(engineSessions.readSessionResetRecallCutoff).mockResolvedValue({
      state: "valid",
      cutoffLine: 5,
    });
    const hits: MemorySearchResult[] = [
      searchHit("sessions/main/current.jsonl", "sessions", "first pre-reset chunk"),
      searchHit("sessions/main/current.jsonl", "sessions", "second pre-reset chunk", {
        score: 0.9,
        startLine: 3,
        endLine: 4,
      }),
    ];

    await expect(filter(hits)).resolves.toEqual(hits);
    expect(engineSessions.readSessionResetRecallCutoff).toHaveBeenCalledTimes(1);
    expect(engineSessions.readSessionResetRecallCutoff).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "current",
      sessionKey: anchorSessionKey,
      storePath: "(test)",
    });
  });

  it("allows an archived reset generation of the private anchor conversation", async () => {
    const hit = searchHit(
      "sessions/main/current.jsonl.reset.2026-08-11T08-00-00.000Z",
      "sessions",
      "prior conversation context",
    );
    await expect(filter([hit])).resolves.toEqual([hit]);
  });

  it("denies an archived deleted generation from another private conversation", async () => {
    combinedSessionStore["agent:main:telegram:direct:deleted-source"] = directEntry(
      "deleted-source",
      1,
    );
    const hit = searchHit(
      "sessions/main/deleted-source.jsonl.deleted.2026-08-11T08-00-00.000Z",
      "sessions",
      "intentionally deleted private context",
    );
    await expect(filter([hit])).resolves.toEqual([]);
  });
});
