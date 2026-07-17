// Memory Core tests cover session search visibility plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachQmdSessionArtifactHit,
  copyQmdSessionArtifactHit,
  replaceQmdSessionArtifactMappings,
  resolveQmdSessionArtifactIdentity,
} from "./qmd-session-artifacts.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
  chatType?: "direct" | "group" | "channel";
  origin?: { chatType?: "direct" | "group" | "channel" };
};

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": {
    sessionId: "w1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/w1.jsonl",
  },
};
let combinedSessionStore: Record<string, TestSessionEntry> = crossAgentStore;
const tempRoots: string[] = [];

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: combinedSessionStore,
    })),
  };
});

describe("filterMemorySearchHitsBySessionVisibility", () => {
  afterEach(async () => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGateway).mockClear();
    combinedSessionStore = crossAgentStore;
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  async function createQmdArtifactIndex(params: {
    agentId: string;
    archived?: boolean;
    artifactPath: string;
    collection: string;
    searchPath: string;
    sessionId: string;
  }): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-session-artifact-"));
    tempRoots.push(root);
    const indexPath = path.join(root, "index.sqlite");
    replaceQmdSessionArtifactMappings({
      collection: params.collection,
      indexPath,
      mappings: [
        {
          agentId: params.agentId,
          archived: params.archived === true,
          artifactPath: params.artifactPath,
          collection: params.collection,
          memoryKey: sessionTranscriptHit.formatSessionTranscriptMemoryHitKey({
            agentId: params.agentId,
            sessionId: params.sessionId,
          }),
          searchPath: params.searchPath,
          sessionId: params.sessionId,
        },
      ],
    });
    return indexPath;
  }

  function attachMappedQmdHit(
    hit: MemorySearchResult,
    lookup: Parameters<typeof resolveQmdSessionArtifactIdentity>[0],
  ): MemorySearchResult {
    const identity = resolveQmdSessionArtifactIdentity(lookup);
    if (!identity) {
      throw new Error("expected QMD session artifact identity mapping");
    }
    return attachQmdSessionArtifactHit(hit, identity);
  }

  it("migrates legacy QMD artifact mappings to STRICT without losing rows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-session-artifact-"));
    tempRoots.push(root);
    const indexPath = path.join(root, "index.sqlite");
    const legacy = new DatabaseSync(indexPath);
    legacy.exec(`
      CREATE TABLE openclaw_qmd_session_artifacts (
        collection TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        search_path TEXT NOT NULL,
        docid TEXT,
        memory_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (collection, artifact_path)
      );
      INSERT INTO openclaw_qmd_session_artifacts (
        collection, artifact_path, search_path, docid, memory_key, agent_id, session_id, updated_at
      ) VALUES ('legacy', 'old.md', 'qmd/legacy/old.md', NULL, 'old-key', 'main', 'old', 1);
    `);
    legacy.close();

    replaceQmdSessionArtifactMappings({
      collection: "current",
      indexPath,
      mappings: [
        {
          agentId: "main",
          archived: true,
          artifactPath: "new.md",
          collection: "current",
          memoryKey: "new-key",
          searchPath: "qmd/current/new.md",
          sessionId: "new",
        },
      ],
    });

    const migrated = new DatabaseSync(indexPath);
    try {
      expect(
        migrated
          .prepare(
            "SELECT strict FROM pragma_table_list WHERE name = 'openclaw_qmd_session_artifacts'",
          )
          .get(),
      ).toEqual({ strict: 1 });
      expect(
        migrated
          .prepare(
            `SELECT collection, artifact_path, archived
             FROM openclaw_qmd_session_artifacts
             ORDER BY collection`,
          )
          .all(),
      ).toEqual([
        { collection: "current", artifact_path: "new.md", archived: 1 },
        { collection: "legacy", artifact_path: "old.md", archived: 0 },
      ]);
      expect(() =>
        migrated
          .prepare(
            "UPDATE openclaw_qmd_session_artifacts SET archived = ? WHERE collection = 'legacy'",
          )
          .run("not-an-integer"),
      ).toThrow();
    } finally {
      migrated.close();
    }
  });

  it("drops sessions-sourced hits when requester key is missing (fail closed)", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/u1.jsonl",
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: undefined,
      sandboxed: false,
      hits,
    });
    expect(filtered).toStrictEqual([]);
  });

  it("keeps non-session hits unchanged", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "memory/foo.md",
        source: "memory",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(filtered).toEqual(hits);
  });

  it("allows another same-agent private transcript through trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:webchat:direct:owner": {
        sessionId: "past",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/past.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/past.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("allows an agent-scoped builtin hit for an Active Memory private requester", async () => {
    const anchorSessionKey = "agent:qa:qa-channel:direct:dm:remember-target";
    combinedSessionStore = {
      [anchorSessionKey]: {
        sessionId: "target-id",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/target-id.jsonl",
        chatType: "direct",
      },
      "agent:qa:qa-channel:direct:dm:remember-source": {
        sessionId: "source-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/source-id.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/qa/source-id.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      agentId: "qa",
      requesterSessionKey: `${anchorSessionKey}:active-memory:7e1ee8190516`,
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey,
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("allows recognized explicit private sessions with persisted direct metadata", async () => {
    const anchorSessionKey = "agent:main:explicit:laptop";
    combinedSessionStore = {
      [anchorSessionKey]: {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        origin: { chatType: "direct" },
      },
      "agent:main:explicit:phone:group:shadow": {
        sessionId: "explicit-private",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/explicit-private.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/explicit-private.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: `${anchorSessionKey}:active-memory:123456abcdef`,
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey,
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("denies recall when the anchor transcript also has a shared group alias", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:telegram:group:team": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "group",
      },
      "agent:main:qa-channel:direct:dm:friend": {
        sessionId: "other-private",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/other-private.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/other-private.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies the shared global session as a recall source despite direct metadata", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      global: {
        sessionId: "global-shared",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/global-shared.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/global-shared.jsonl",
      source: "sessions",
      score: 1,
      snippet: "shared global context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: { sessions: { visibility: "self" } },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies recall anchored in the shared global session despite direct metadata", async () => {
    combinedSessionStore = {
      "agent:main:global": {
        sessionId: "global-shared",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/global-shared.jsonl",
        chatType: "direct",
      },
      "agent:main:qa-channel:direct:dm:friend": {
        sessionId: "other-private",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/other-private.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/other-private.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: { sessions: { visibility: "self" } },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:global",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:global",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies a metadata-less generated explicit model-run transcript", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:model-run-probe": {
        sessionId: "model-run-probe",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/model-run-probe.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/model-run-probe.jsonl",
      source: "sessions",
      score: 1,
      snippet: "internal model probe",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies another agent's private transcript during trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:peer:telegram:direct:owner": {
        sessionId: "peer-private",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/peer-private.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/peer-private.jsonl",
      source: "sessions",
      score: 1,
      snippet: "other agent context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies persisted Active Memory helper transcripts under explicit sessions", async () => {
    combinedSessionStore = {
      "agent:main:explicit:laptop": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:laptop:active-memory:abcdef123456": {
        sessionId: "helper",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/helper.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/helper.jsonl",
      source: "sessions",
      score: 1,
      snippet: "internal helper transcript",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:explicit:laptop:active-memory:123456abcdef",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:explicit:laptop",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("excludes the anchor transcript from trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/current.jsonl",
      source: "sessions",
      score: 1,
      snippet: "already in context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("excludes the anchor transcript when another private key aliases the same session", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:legacy-owner-alias": {
        sessionId: "current",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/current.jsonl",
      source: "sessions",
      score: 1,
      snippet: "already in context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it.each([
    { name: "group", chatType: "group" as const },
    { name: "channel", chatType: "channel" as const },
    { name: "unknown", chatType: undefined },
  ])("denies $name transcript hits from trusted conversation recall", async ({ chatType }) => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      [chatType ? "agent:main:telegram:group:family" : "agent:main:unknown-surface"]: {
        sessionId: "candidate",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/candidate.jsonl",
        ...(chatType ? { chatType } : {}),
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/candidate.jsonl",
      source: "sessions",
      score: 1,
      snippet: "not private",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("rejects a transcript when one alias is private and another alias is shared", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 3,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:telegram:direct:private-alias": {
        sessionId: "candidate",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/candidate.jsonl",
        chatType: "direct",
      },
      "agent:main:telegram:group:shared-alias": {
        sessionId: "candidate",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/candidate.jsonl",
        chatType: "group",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/candidate.jsonl",
      source: "sessions",
      score: 1,
      snippet: "shared transcript",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies a metadata-less main transcript during trusted conversation recall", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:main": {
        sessionId: "ambiguous-main",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/ambiguous-main.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/ambiguous-main.jsonl",
      source: "sessions",
      score: 1,
      snippet: "unknown conversation kind",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("rejects a synthetic recall requester that does not start with the anchor key", async () => {
    combinedSessionStore = {
      "agent:main:main": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:webchat:direct:owner": {
        sessionId: "past",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/past.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/past.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:xxxx:active-memory:abcdef123456",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("denies trusted conversation recall when the anchor is shared, mismatched, or sandboxed", async () => {
    combinedSessionStore = {
      "agent:main:telegram:group:family": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "group",
      },
      "agent:main:webchat:direct:owner": {
        sessionId: "past",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/past.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/past.jsonl",
      source: "sessions",
      score: 1,
      snippet: "private context",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:group:family",
      scope: "same-agent-private" as const,
      corpus: "sessions" as const,
    };

    const [sharedAnchor, mismatchedAnchor, sandboxed] = await Promise.all([
      filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: conversationRecall.anchorSessionKey,
        sandboxed: false,
        hits: [hit],
        conversationRecall,
      }),
      filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: "agent:main:webchat:direct:owner",
        sandboxed: false,
        hits: [hit],
        conversationRecall,
      }),
      filterMemorySearchHitsBySessionVisibility({
        cfg,
        requesterSessionKey: conversationRecall.anchorSessionKey,
        sandboxed: true,
        hits: [hit],
        conversationRecall,
      }),
    ]);

    expect(sharedAnchor).toStrictEqual([]);
    expect(mismatchedAnchor).toStrictEqual([]);
    expect(sandboxed).toStrictEqual([]);
  });

  it("preserves ordinary memory while denying unauthorized configured transcript recall", async () => {
    combinedSessionStore = {};
    const memoryHit: MemorySearchResult = {
      path: "MEMORY.md",
      source: "memory",
      score: 1,
      snippet: "shared workspace memory",
      startLine: 1,
      endLine: 2,
    };
    const sessionHit: MemorySearchResult = {
      path: "sessions/private.jsonl",
      source: "sessions",
      score: 0.9,
      snippet: "private transcript",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main:active-memory:abcdef123456",
      sandboxed: false,
      hits: [memoryHit, sessionHit],
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "configured",
      },
    });

    expect(filtered).toEqual([memoryHit]);
  });

  it("restricts trusted sessions-only recall to transcript hits", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "memory/private.md",
      source: "memory",
      score: 1,
      snippet: "workspace memory",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("loads the combined session store once per filter pass", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/w1.jsonl",
        source: "sessions",
        score: 1,
        snippet: "a",
        startLine: 1,
        endLine: 2,
      },
      {
        path: "sessions/w1.jsonl",
        source: "sessions",
        score: 0.9,
        snippet: "b",
        startLine: 1,
        endLine: 2,
      },
    ];
    await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledTimes(1);
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("keeps same-agent session hits when visibility=all and agent-to-agent is enabled", async () => {
    combinedSessionStore = {
      "agent:main:only": {
        sessionId: "w1",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/w1.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("keeps built-in live SQLite session hits with agent-scoped logical paths", async () => {
    combinedSessionStore = {
      "agent:main:only": {
        sessionId: "w1",
        updatedAt: 1,
        sessionFile: "sqlite-session://main/w1",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/main/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("keeps global-scope session hits for non-default agents", async () => {
    combinedSessionStore = {
      global: {
        sessionId: "w1",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/w1.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      agentId: "secondary",
      requesterSessionKey: "agent:secondary:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("does not keep cross-agent session hits outside the scoped store", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not keep cross-agent session hits when a shared store returns out-of-scope keys", async () => {
    combinedSessionStore = crossAgentStore;
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not keep owner-qualified cross-agent hits that collide with a scoped stem", async () => {
    combinedSessionStore = {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/main.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/peer/main.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("denies cross-agent session hits when agent-to-agent is disabled", async () => {
    const hit: MemorySearchResult = {
      path: "sessions/w1.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("keeps same-agent deleted archive hits using owner metadata when the live store entry is gone", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/main/deleted-stem.jsonl.deleted.2026-02-16T22-27-33.000Z",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("still denies cross-agent deleted archive hits resolved from owner metadata when a2a is disabled", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/peer/deleted-stem.jsonl.deleted.2026-02-16T22-27-33.000Z",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("does not keep cross-agent deleted archive hits outside the scoped store when a2a is allowed", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/peer/deleted-stem.jsonl.deleted.2026-02-16T22-27-33.000Z",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps same-agent QMD-normalized archived reset .md hits when the store has a matching entry", async () => {
    combinedSessionStore = {
      "agent:main:abc-uuid": {
        sessionId: "abc-uuid",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/abc-uuid.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/abc-uuid-jsonl-reset-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("keeps QMD .md hits whose live session id looks like an archive name", async () => {
    const sessionId = "foo.jsonl.deleted.2026-02-16T22-27-33.000Z";
    combinedSessionStore = {
      "agent:main:archive-looking": {
        sessionId,
        updatedAt: 1,
        sessionFile: `/tmp/sessions/${sessionId}.jsonl`,
      },
    };
    const hit: MemorySearchResult = {
      path: `qmd/sessions-main/${sessionId}.md`,
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:archive-looking",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("does not authorize QMD archived .md hits through lossy slug fallback", async () => {
    combinedSessionStore = {
      "agent:main:foo_bar": {
        sessionId: "foo_bar",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/foo_bar.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/foo-bar-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:foo_bar",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps mapped QMD session hits when the artifact filename no longer matches the session id", async () => {
    combinedSessionStore = {
      "agent:main:actual-key": {
        sessionId: "actual-session-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/actual-session-id.jsonl",
      },
    };
    const searchPath = "qmd/sessions-main/lossy-export-name.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "lossy-export-name.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "actual-session-id",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "lossy-export-name.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const copiedHit = copyQmdSessionArtifactHit(hit, { ...hit, snippet: "trimmed" });
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:actual-key",
      sandboxed: false,
      hits: [copiedHit],
    });

    expect(filtered).toEqual([copiedHit]);
  });

  it("denies mapped QMD hits whose transcript file also has a shared group alias", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:laptop": {
        sessionId: "actual-session-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/shared-transcript.jsonl",
        chatType: "direct",
      },
      // Same transcript file exposed under a group alias with a different
      // sessionId: session-id alias resolution alone would miss this.
      "agent:main:telegram:group:team": {
        sessionId: "group-alias-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/shared-transcript.jsonl",
        chatType: "group",
      },
    };
    const searchPath = "qmd/sessions-main/shared-transcript-export.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "shared-transcript-export.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "actual-session-id",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "private context",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "shared-transcript-export.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("allows mapped QMD hits for another same-agent private conversation", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
      "agent:main:explicit:laptop": {
        sessionId: "actual-session-id",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/actual-session-id.jsonl",
        chatType: "direct",
      },
    };
    const searchPath = "qmd/sessions-main/lossy-export-name.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "lossy-export-name.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "actual-session-id",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "private context",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "lossy-export-name.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "self" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toEqual([hit]);
  });

  it("denies mapped live QMD session hits when no session-store key remains", async () => {
    combinedSessionStore = {};
    const searchPath = "qmd/sessions-main/orphan-live.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      artifactPath: "orphan-live.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "orphan-live",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "orphan-live.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps mapped archived QMD session hits when no session-store key remains", async () => {
    combinedSessionStore = {};
    const searchPath = "qmd/sessions-main/archived-jsonl-deleted-2026-02-16t22-26-33-000z.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "main",
      archived: true,
      artifactPath: "archived-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "archived",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "archived-jsonl-deleted-2026-02-16t22-26-33-000z.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("denies mapped QMD session hits before deprecated filename fallback", async () => {
    combinedSessionStore = {
      "agent:main:visible": {
        sessionId: "visible",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/visible.jsonl",
      },
    };
    const searchPath = "qmd/sessions-main/visible.md";
    const indexPath = await createQmdArtifactIndex({
      agentId: "peer",
      artifactPath: "visible.md",
      collection: "sessions-main",
      searchPath,
      sessionId: "peer-session",
    });
    const hit = attachMappedQmdHit(
      {
        path: searchPath,
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
      {
        artifactPath: "visible.md",
        collection: "sessions-main",
        indexPath,
        searchPath,
      },
    );
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:visible",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps same-agent QMD archived deleted .md hits when no store entry remains", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/abc-uuid-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });
});
