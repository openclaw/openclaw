import * as engineSessions from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { normalizeSessionDeliveryState } from "openclaw/plugin-sdk/session-store-runtime";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import * as sessionVisibility from "openclaw/plugin-sdk/session-visibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import {
  searchHit,
  sessionEntry,
  type TestSessionEntry,
} from "./session-search-visibility.test-support.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

const anchorSessionKey = "agent:main:telegram:direct:owner";
type FilterOptions = Parameters<typeof filterMemorySearchHitsBySessionVisibility>[0];
const visibilityConfig = (visibility: "all" | "agent" | "self" = "self") =>
  asOpenClawConfig({ tools: { sessions: { visibility } } });
const entry = (id: string, updatedAt: number, metadata?: Parameters<typeof sessionEntry>[3]) =>
  sessionEntry(id, updatedAt, `/tmp/sessions/${id}.jsonl`, metadata);
const directEntry = (id: string, updatedAt: number) => entry(id, updatedAt, { chatType: "direct" });
const directDelivery = (id: string) =>
  normalizeSessionDeliveryState({
    context: { channel: "discord", to: `user:${id}` },
    origin: { provider: "discord", chatType: "direct", to: `user:${id}` },
  });
function filter(hits: MemorySearchResult[], overrides: Partial<FilterOptions> = {}) {
  return filterMemorySearchHitsBySessionVisibility({
    cfg: visibilityConfig(),
    requesterSessionKey: anchorSessionKey,
    sandboxed: false,
    hits,
    ...overrides,
  });
}
function recall(hits: MemorySearchResult[], overrides: Partial<FilterOptions> = {}) {
  return filter(hits, {
    conversationRecall: recallContext(),
    ...overrides,
  });
}

const recallContext = (
  anchor = anchorSessionKey,
  corpus: "sessions" | "configured" = "sessions",
) => ({
  anchorSessionKey: anchor,
  scope: "same-agent-private" as const,
  corpus,
});

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": sessionEntry("w1", 1, "/tmp/sessions/w1.jsonl"),
};
let combinedSessionStore: Record<string, TestSessionEntry> = crossAgentStore;

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

describe("filterMemorySearchHitsBySessionVisibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGatewayAsync).mockClear();
    combinedSessionStore = crossAgentStore;
  });

  it("drops sessions-sourced hits when requester key is missing (fail closed)", async () => {
    const hits: MemorySearchResult[] = [searchHit("sessions/u1.jsonl", "sessions", "x")];
    const filtered = await filter(hits, {
      cfg: visibilityConfig("all"),
      requesterSessionKey: undefined,
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not load session history for memory-only hits with configured recall", async () => {
    const guard = vi.spyOn(sessionVisibility, "createSessionVisibilityGuard");
    const hits: MemorySearchResult[] = [searchHit("memory/foo.md", "memory", "x")];
    const filtered = await filter(hits, {
      cfg: visibilityConfig("all"),
      requesterSessionKey: "agent:main:main",
      conversationRecall: recallContext("agent:main:main", "configured"),
    });
    expect(filtered).toEqual(hits);
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGatewayAsync).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("applies default visibility to unrelated same-agent recall from a voice requester", async () => {
    combinedSessionStore = {
      "agent:main:voice:15550001111": directEntry("voice", 2),
      [anchorSessionKey]: directEntry("private", 1),
    };
    const memoryHit = searchHit("memory/allowed.md", "memory", "Visible memory");
    const sessionHit = searchHit("sessions/private.jsonl", "sessions", "Private session secret");

    const filtered = await filter([memoryHit, sessionHit], {
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: undefined } } }),
      agentId: "main",
      requesterSessionKey: "agent:main:voice:15550001111",
    });

    expect(filtered).toEqual([memoryHit, sessionHit]);
  });

  it("allows recognized explicit private sessions with persisted direct metadata", async () => {
    const explicitAnchor = "agent:main:explicit:laptop";
    combinedSessionStore = {
      [explicitAnchor]: entry("current", 2, {
        delivery: directDelivery("current"),
      }),
      "agent:main:explicit:phone:group:shadow": entry("explicit-private", 1, {
        chatType: "direct",
        delivery: directDelivery("explicit-private"),
      }),
    };
    const hit = searchHit("sessions/explicit-private.jsonl", "sessions", "private context");
    const filtered = await recall([hit], {
      requesterSessionKey: `${explicitAnchor}:active-memory:123456abcdef`,
      conversationRecall: recallContext(explicitAnchor),
    });

    expect(filtered).toEqual([hit]);
  });

  it("denies recall when the anchor transcript also has a shared group alias", async () => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 2),
      "agent:main:telegram:group:team": entry("current", 2, {
        chatType: "group",
      }),
      "agent:main:qa-channel:direct:dm:friend": directEntry("other-private", 1),
    };
    const hit = searchHit(
      "sessions/main/current.jsonl.reset.2026-08-11T08-00-00.000Z",
      "sessions",
      "prior private context",
    );
    const filtered = await recall([hit]);

    expect(filtered).toStrictEqual([]);
  });

  it("denies the shared global session as a recall source despite direct metadata", async () => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 2),
      global: directEntry("global-shared", 1),
    };
    const hit = searchHit("sessions/global-shared.jsonl", "sessions", "shared global context");
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: { sessions: { visibility: "self" } },
    });

    const filtered = await recall([hit], { cfg });

    expect(filtered).toStrictEqual([]);
  });

  it("denies recall anchored in the shared global session despite direct metadata", async () => {
    combinedSessionStore = {
      "agent:main:global": directEntry("global-shared", 2),
      "agent:main:qa-channel:direct:dm:friend": directEntry("other-private", 1),
    };
    const hit = searchHit("sessions/other-private.jsonl", "sessions", "private context");
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: { sessions: { visibility: "self" } },
    });

    const filtered = await recall([hit], {
      cfg,
      requesterSessionKey: "agent:main:global",
      conversationRecall: recallContext("agent:main:global"),
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies a metadata-less generated explicit model-run transcript", async () => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 2),
      "agent:main:explicit:model-run-probe": entry("model-run-probe", 1),
    };
    const hit = searchHit("sessions/model-run-probe.jsonl", "sessions", "internal model probe");
    const filtered = await recall([hit]);

    expect(filtered).toStrictEqual([]);
  });

  it.each([
    { name: "live", path: "sessions/peer-private.jsonl" },
    {
      name: "archived",
      path: "sessions/peer/peer-private.jsonl.reset.2026-08-11T08-00-00.000Z",
    },
  ])(
    "denies another agent's $name private transcript during trusted conversation recall",
    async ({ path }) => {
      combinedSessionStore = {
        [anchorSessionKey]: directEntry("current", 2),
        "agent:peer:telegram:direct:owner": directEntry("peer-private", 1),
      };
      const hit = searchHit(path, "sessions", "other agent context");
      const filtered = await recall([hit], { cfg: visibilityConfig("all") });

      expect(filtered).toStrictEqual([]);
    },
  );

  it("denies persisted Active Memory helper transcripts under explicit sessions", async () => {
    combinedSessionStore = {
      "agent:main:explicit:laptop": directEntry("current", 2),
      "agent:main:explicit:laptop:active-memory:abcdef123456": entry("helper", 1),
    };
    const hit = searchHit("sessions/helper.jsonl", "sessions", "internal helper transcript");
    const filtered = await recall([hit], {
      cfg: visibilityConfig("agent"),
      requesterSessionKey: "agent:main:explicit:laptop:active-memory:123456abcdef",
      conversationRecall: recallContext("agent:main:explicit:laptop"),
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies unknown transcript hits from trusted conversation recall", async () => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 2),
      "agent:main:unknown-surface": entry("candidate", 1, {}),
    };
    const hit = searchHit("sessions/candidate.jsonl", "sessions", "not private");
    const filtered = await recall([hit], { cfg: visibilityConfig("agent") });

    expect(filtered).toStrictEqual([]);
  });

  it("rejects a transcript when one alias is private and another alias is shared", async () => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 3),
      "agent:main:telegram:direct:private-alias": directEntry("candidate", 2),
      "agent:main:telegram:group:shared-alias": entry("candidate", 1, { chatType: "group" }),
    };
    const hit = searchHit("sessions/candidate.jsonl", "sessions", "shared transcript");
    const filtered = await recall([hit], { cfg: visibilityConfig("agent") });

    expect(filtered).toStrictEqual([]);
  });

  it("denies trusted conversation recall when the anchor is shared, mismatched, or sandboxed", async () => {
    combinedSessionStore = {
      "agent:main:telegram:group:family": entry("current", 2, { chatType: "group" }),
      "agent:main:webchat:direct:owner": directEntry("past", 1),
    };
    const hit = searchHit("sessions/past.jsonl", "sessions", "private context");
    const conversationRecall = recallContext("agent:main:telegram:group:family");

    const [sharedAnchor, mismatchedAnchor, sandboxed] = await Promise.all([
      recall([hit], {
        requesterSessionKey: conversationRecall.anchorSessionKey,
        conversationRecall,
      }),
      recall([hit], {
        requesterSessionKey: "agent:main:webchat:direct:owner",
        conversationRecall,
      }),
      recall([hit], {
        requesterSessionKey: conversationRecall.anchorSessionKey,
        sandboxed: true,
        conversationRecall,
      }),
    ]);

    expect(sharedAnchor).toStrictEqual([]);
    expect(mismatchedAnchor).toStrictEqual([]);
    expect(sandboxed).toStrictEqual([]);
  });

  it("preserves ordinary memory while denying unauthorized configured transcript recall", async () => {
    combinedSessionStore = {};
    const memoryHit = searchHit("MEMORY.md", "memory", "shared workspace memory");
    const sessionHit = searchHit("sessions/private.jsonl", "sessions", "private transcript", {
      score: 0.9,
    });
    const filtered = await recall([memoryHit, sessionHit], {
      cfg: visibilityConfig("all"),
      requesterSessionKey: "agent:main:main:active-memory:abcdef123456",
      conversationRecall: recallContext("agent:main:main", "configured"),
    });

    expect(filtered).toEqual([memoryHit]);
  });

  it("restricts trusted sessions-only recall to transcript hits", async () => {
    combinedSessionStore = {
      [anchorSessionKey]: directEntry("current", 2),
    };
    const hit = searchHit("memory/private.md", "memory", "workspace memory");
    const filtered = await recall([hit], { cfg: visibilityConfig("agent") });

    expect(filtered).toStrictEqual([]);
  });

  it.each([
    { sandboxed: false, visible: true },
    { sandboxed: true, visible: false },
  ])(
    "applies canonical-main tree visibility with sandboxed=$sandboxed",
    async ({ sandboxed, visible }) => {
      combinedSessionStore = {
        "agent:main:slack:channel:team": entry("team", 1, {
          chatType: "channel",
        }),
      };
      const hit = searchHit("sessions/team.jsonl", "sessions", "team context");

      const filtered = await filter([hit], {
        cfg: asOpenClawConfig({
          tools: { sessions: { visibility: "tree" } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        }),
        requesterSessionKey: "agent:main:main",
        sandboxed,
      });

      expect(filtered).toEqual(visible ? [hit] : []);
    },
  );

  it("keeps same-agent live orphan transcript hits", async () => {
    combinedSessionStore = {};
    const hit = searchHit("sessions/main/live-orphan.jsonl", "sessions", "x");
    const filtered = await filter([hit], {
      cfg: visibilityConfig("agent"),
      requesterSessionKey: "agent:main:main",
    });
    expect(filtered).toEqual([hit]);
  });

  it("does not treat a same-agent orphan filename as proven self-session lineage", async () => {
    combinedSessionStore = {};
    const hit = searchHit("sessions/main/main.jsonl", "sessions", "x");
    const filtered = await filter([hit], {
      requesterSessionKey: "agent:main:main",
    });
    expect(filtered).toStrictEqual([]);
  });
});

const archiveRecord = (archiveName: string, sessionId: string) => ({
  agentId: "main",
  archiveName,
  sessionId,
  sessionKey: anchorSessionKey,
  createdAt: 1,
});
function resetFilter(hits: MemorySearchResult[], overrides: Partial<FilterOptions> = {}) {
  return recall(hits, {
    agentId: "main",
    requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
    ...overrides,
  });
}

describe("reset-generation session search visibility", () => {
  beforeEach(() => {
    combinedSessionStore = { [anchorSessionKey]: directEntry("current", 2) };
    vi.spyOn(engineSessions, "readSessionResetRecallCutoff").mockResolvedValue({ state: "absent" });
    vi.spyOn(engineSessions, "loadArchivedSessionsAsync").mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGatewayAsync).mockClear();
    combinedSessionStore = crossAgentStore;
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
      resetFilter([hit], {
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
      resetFilter([searchHit(`sessions/main/${archiveName}`, "sessions", "private context")], {
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

    await expect(resetFilter([hit])).resolves.toEqual([]);
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

    await expect(resetFilter(hits)).resolves.toEqual(hits);
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
    await expect(resetFilter([hit])).resolves.toEqual([hit]);
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
    await expect(resetFilter([hit])).resolves.toEqual([]);
  });
});
