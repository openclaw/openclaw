import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown, type WikiClaim } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { registerSessionlessAgentScopeQueryTests } from "./query.session-scope.test-support.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiGetTool } from "./tool.js";

const {
  getActiveMemorySearchManagerMock,
  getActiveMemoryProviderMock,
  isActiveMemoryProviderNativeMock,
  loadMemorySearchSessionStoreMock,
  resolveDefaultAgentIdMock,
  resolveSessionAgentIdMock,
} = vi.hoisted(() => ({
  getActiveMemorySearchManagerMock: vi.fn(),
  getActiveMemoryProviderMock: vi.fn(),
  isActiveMemoryProviderNativeMock: vi.fn(),
  loadMemorySearchSessionStoreMock: vi.fn(),
  resolveDefaultAgentIdMock: vi.fn(() => "main"),
  resolveSessionAgentIdMock: vi.fn(({ sessionKey }: { sessionKey?: string }) => {
    const match = /^agent:([^:]+):/.exec(sessionKey ?? "");
    return match?.[1] ?? "main";
  }),
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
  getActiveMemoryProvider: getActiveMemoryProviderMock,
  isActiveMemoryProviderNative: isActiveMemoryProviderNativeMock,
}));

vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  resolveSessionAgentIdStrict: resolveSessionAgentIdMock,
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-sessions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-sessions")>();
  return {
    ...actual,
    loadMemorySearchSessionStore: loadMemorySearchSessionStoreMock,
  };
});

function managedBlock(kind: string, body = "") {
  return `<!-- openclaw:${kind}:start -->\n${body ? body + "\n" : ""}<!-- openclaw:${kind}:end -->`;
}

function claim(id: string, text: string, overrides: Partial<WikiClaim> = {}) {
  return { id, text, status: "supported", confidence: 0.9, evidence: [], ...overrides };
}

function relationship(kind: string, note: string) {
  return { targetId: "entity.alice", targetTitle: "Alice", kind, note };
}

function writeVaultPage(
  rootDir: string,
  relativePath: string,
  title: string,
  body: string,
  fields: Record<string, unknown> = {},
) {
  const pageType = relativePath.startsWith("entities/") ? "entity" : "source";
  const id = pageType + "." + path.basename(relativePath, ".md");
  return fs.writeFile(
    path.join(rootDir, relativePath),
    renderWikiMarkdown({ frontmatter: { pageType, id, title, ...fields }, body }),
    "utf8",
  );
}

const { createVault } = createMemoryWikiTestHarness();

function searchWiki(
  config: Parameters<typeof searchMemoryWiki>[0]["config"],
  query: string,
  options: Omit<Parameters<typeof searchMemoryWiki>[0], "config" | "query"> = {},
) {
  return searchMemoryWiki({ config, query, ...options });
}

function readWiki(
  config: Parameters<typeof getMemoryWikiPage>[0]["config"],
  lookup: string,
  options: Omit<Parameters<typeof getMemoryWikiPage>[0], "config" | "lookup"> = {},
) {
  return getMemoryWikiPage({ config, lookup, ...options });
}

type SearchOptions = Parameters<typeof searchWiki>[2];

function collectWikiResultPaths(results: readonly { corpus: string; path?: string }[]): string[] {
  return results.flatMap((result) =>
    result.corpus === "wiki" && result.path ? [result.path] : [],
  );
}

beforeEach(() => {
  getActiveMemorySearchManagerMock
    .mockReset()
    .mockResolvedValue({ manager: null, error: "unavailable" });
  getActiveMemoryProviderMock.mockReset();
  // Memory Core owns the slot unless a test selects a native provider.
  isActiveMemoryProviderNativeMock.mockReset().mockResolvedValue(false);
  loadMemorySearchSessionStoreMock
    .mockReset()
    .mockResolvedValue({ storePath: "(test)", store: {} });
  resolveDefaultAgentIdMock.mockClear();
  resolveSessionAgentIdMock.mockClear();
});

async function createQueryVault(options?: {
  config?: MemoryWikiPluginConfig;
  initialize?: boolean;
}) {
  const vault = await createVault({
    prefix: "memory-wiki-query-",
    initialize: options?.initialize ?? true,
    config: options?.config,
  });
  return {
    ...vault,
    search: (query: string, opts?: SearchOptions) => searchWiki(vault.config, query, opts),
    searchPaths: async (query: string, opts?: SearchOptions) =>
      (await searchWiki(vault.config, query, opts)).map((result) => result.path),
    writePage: writeVaultPage.bind(null, vault.rootDir),
    writeNote: (relativePath: string, title: string, text: string, fields = {}) =>
      writeVaultPage(vault.rootDir, relativePath, title, `# ${title}\n\n${text}\n`, fields),
  };
}

function createSharedVault(corpus: "all" | "wiki" | "memory") {
  return createQueryVault({ config: { search: { backend: "shared", corpus } } });
}

function createAppConfig(): OpenClawConfig {
  return { agents: { entries: { main: {} } } } as OpenClawConfig;
}

function createSessionVisibilityAppConfig(): OpenClawConfig {
  return {
    agents: {
      ...createAppConfig().agents,
      defaults: { sandbox: { sessionToolsVisibility: "all" } },
    },
    tools: { sessions: { visibility: "self" } },
  } as OpenClawConfig;
}

function createAgentSessionVisibilityAppConfig(): OpenClawConfig {
  return {
    agents: { entries: { main: {}, secondary: {} } },
    tools: { sessions: { visibility: "agent" } },
  } as OpenClawConfig;
}

function mockSessionStore(
  store: Record<
    string,
    { sessionId: string; updatedAt: number; sessionFile?: string; chatType?: string }
  >,
) {
  loadMemorySearchSessionStoreMock.mockResolvedValue({
    storePath: "(test)",
    store,
  });
}

function memoryHit(
  hitPath: string,
  score = 1,
  source: "memory" | "sessions" = "sessions",
  details: { startLine?: number; endLine?: number; citation?: string } = {},
) {
  return { path: hitPath, startLine: 1, endLine: 2, score, snippet: hitPath, source, ...details };
}

function createMemoryManager(overrides?: {
  searchResults?: ReturnType<typeof memoryHit>[];
  readResult?: MemoryReadResult;
}) {
  return {
    search: vi.fn().mockResolvedValue(overrides?.searchResults ?? []),
    readFile: vi.fn().mockImplementation(async () => {
      if (!overrides?.readResult) {
        throw new Error("missing");
      }
      return overrides.readResult;
    }),
  };
}

function useMemoryManager(overrides?: Parameters<typeof createMemoryManager>[0]) {
  const manager = createMemoryManager(overrides);
  getActiveMemorySearchManagerMock.mockResolvedValue({ manager });
  return manager;
}

describe("searchMemoryWiki", () => {
  it("skips malformed pages while searching the rest of the vault (#96125)", async () => {
    const { rootDir, searchPaths, writeNote } = await createQueryVault();
    await fs.writeFile(
      path.join(rootDir, "sources", "broken.md"),
      '---\npageType: source\nid: source.broken\nsourceIds:\n  - **MEMORY.md line 235**:"some quoted, value"\n---\n\n# Broken\n\npoison needle',
      "utf8",
    );
    await writeNote("sources/healthy.md", "Healthy Source", "healthy needle");

    expect(await searchPaths("needle", { maxResults: Number.NaN })).toEqual(["sources/healthy.md"]);
  });

  it("strips related blocks and structural markers, but retains content and inline prose", async () => {
    const { search, searchPaths, writePage, writeNote } = await createQueryVault();
    await writeNote(
      "entities/alpha.md",
      "Alpha",
      "Alpha body.\n\n## Related\n" +
        managedBlock(
          "wiki:related",
          "### Related Pages\n- [Needle Person](entities/needle-person.md)",
        ),
      { sourceIds: ["source.alpha"] },
    );
    await writeNote("entities/needle-person.md", "Needle Person", "Needle body.", {
      sourceIds: ["source.alpha"],
    });

    const markers = `${managedBlock("human")}\n<!-- openclaw:wiki:raw-source -->\n`;
    await Promise.all([
      writePage(
        "entities/marker-only.md",
        "Marker Only",
        `${managedBlock("wiki:generated")}\n${markers}`,
      ),
      writePage(
        "entities/evidence.md",
        "Evidence Page",
        managedBlock("human", "# Evidence Page\n\nReadable release evidence summary.") + "\n",
        {
          description: "openclaw release evidence",
          claims: [
            claim("claim.evidence", "Neutral release note.", {
              confidence: 0.8,
              evidence: [{ note: "supporting reference" }],
            }),
          ],
        },
      ),
      writeNote(
        "entities/marker-heavy.md",
        "Marker Heavy",
        `${managedBlock("wiki:generated", "openclaw body reference")}\n${markers}`,
      ),
      writeNote("entities/clean.md", "Clean", "openclaw openclaw body reference"),
      writeNote(
        "entities/managed-content.md",
        "Managed Content",
        managedBlock("wiki:generated", "Cobalt content remains searchable."),
      ),
      writeNote(
        "entities/inline-marker.md",
        "Inline Marker",
        "The literal <!-- openclaw:wiki:generated:start --> inline-needle stays searchable.",
      ),
    ]);
    expect(await searchPaths("Needle Person")).toEqual(["entities/needle-person.md"]);
    const evidenceResults = await search("openclaw release");
    expect(evidenceResults.map((result) => result.path)).toEqual(["entities/evidence.md"]);
    expect(evidenceResults[0]?.snippet).toBe("Readable release evidence summary.");

    const openClawResults = await search("openclaw");
    const paths = openClawResults.map((result) => result.path);
    expect(paths).not.toContain("entities/marker-only.md");
    expect(
      openClawResults.find((result) => result.path === "entities/clean.md")?.score,
    ).toBeGreaterThan(
      openClawResults.find((result) => result.path === "entities/marker-heavy.md")?.score ?? 0,
    );
    expect(await search("cobalt")).toMatchObject([
      { path: "entities/managed-content.md", snippet: "Cobalt content remains searchable." },
    ]);
    expect(await search("inline-needle")).toMatchObject([
      {
        path: "entities/inline-marker.md",
        snippet: expect.stringContaining("<!-- openclaw:wiki:generated:start -->"),
      },
    ]);
  });

  it("matches non-ASCII query terms without an exact phrase", async () => {
    const { searchPaths, writeNote } = await createQueryVault();
    const pages = [
      ["ru", "Альфа — это новый внутренний проект."],
      ["ja", "会議は来週東京で開きます。"],
      ["de", "Die Straße gehört Herrn Müller."],
      ["controller", "The controller strategy is documented here."],
    ] as const;
    for (const [slug, body] of pages) {
      await writeNote(`entities/${slug}.md`, `Notes ${slug}`, body);
    }

    expect(await searchPaths("проект альфа")).toEqual(["entities/ru.md"]);
    expect(await searchPaths("東京 会議")).toEqual(["entities/ja.md"]);
    expect(await searchPaths("Müller Straße")).toEqual(["entities/de.md"]);
  });

  it("routes people through cards and compiled relationships and exposes claim evidence", async () => {
    const { config, search, writeNote } = await createQueryVault();
    await writeNote("entities/brad.md", "Brad Groux", "Agent card summary.", {
      entityType: "person",
      canonicalId: "maintainer.brad-groux",
      aliases: ["bgroux"],
      privacyTier: "local-private",
      personCard: {
        handles: ["@bgroux"],
        lane: "Microsoft Teams",
        askFor: ["Teams and Azure rollout questions"],
      },
      bestUsedFor: ["Microsoft ecosystem routing"],
      relationships: [
        relationship("works-with", "Teams escalation buddy"),
        relationship("collaborates-with", "Azure escalation buddy"),
      ],
      claims: [
        claim("claim.brad.teams", "Brad is a strong route for Microsoft Teams questions.", {
          confidence: 0.88,
          evidence: [
            {
              kind: "maintainer-whois",
              sourceId: "source.maintainers",
              privacyTier: "local-private",
            },
          ],
        }),
      ],
    });
    await writeNote(
      "sources/maintainers.md",
      "Maintainers Source",
      "maintainer-whois Teams sample.",
    );
    await writeNote("entities/fallback.md", "Fallback Router", "Generic routing note.", {
      bestUsedFor: ["Azure escalation buddy"],
    });
    await compileMemoryWikiVault(config);

    const personResults = await search("bgroux", { mode: "find-person" });
    expect(personResults[0]).toMatchObject({
      path: "entities/brad.md",
      canonicalId: "maintainer.brad-groux",
      aliases: ["bgroux"],
      privacyTier: "local-private",
      searchMode: "find-person",
    });

    const routeResults = await search("who should I ask about Teams?", {
      mode: "route-question",
    });
    expect(routeResults[0]?.path).toBe("entities/brad.md");

    const claimResults = await search("strong route Teams", { mode: "raw-claim" });
    expect(claimResults[0]).toMatchObject({
      path: "entities/brad.md",
      matchedClaimId: "claim.brad.teams",
      matchedClaimConfidence: 0.88,
      evidenceKinds: ["maintainer-whois"],
      evidenceSourceIds: ["source.maintainers"],
    });

    const evidenceResults = await search("maintainer-whois", {
      mode: "source-evidence",
      maxResults: 5,
    });
    expect(evidenceResults.map((result) => result.path)).toContain("sources/maintainers.md");
    const relationshipResults = await search("who should I ask about Azure escalation buddy?", {
      mode: "route-question",
      maxResults: 1,
    });
    expect(relationshipResults[0]?.path).toBe("entities/brad.md");
  });

  it.each([
    {
      name: "oversized structured claims",
      source: "claim",
      text: `needle ${"x".repeat(20_000)}`,
      expected: `needle ${"x".repeat(693)}`,
    },
    {
      name: "UTF-16 surrogate pairs at the snippet boundary",
      source: "body",
      text: `needle ${"x".repeat(692)}🤖tail`,
      expected: `needle ${"x".repeat(692)}`,
    },
  ])(
    "bounds $name before search results reach model context",
    async ({ source, text, expected }) => {
      const { search, writePage } = await createQueryVault();
      await writePage(
        "entities/bounded-snippet.md",
        "Bounded Snippet",
        source === "claim" ? "# Bounded Snippet\n\nUnrelated body.\n" : `# Wiki\n\n${text}\n`,
        source === "claim" ? { claims: [claim("claim.bounded-snippet", text)] } : {},
      );

      expect(await search("needle")).toMatchObject([{ snippet: expected }]);
    },
  );

  it("ranks fresh supported claims ahead of stale contested claims", async () => {
    const { searchPaths, writeNote } = await createQueryVault();
    for (const [slug, title, updatedAt, status, confidence, sourceId, lines] of [
      ["fresh", "Fresh", "2026-04-01T00:00:00.000Z", "supported", 0.91, "source.alpha", "4-7"],
      ["stale", "Stale", "2025-10-01T00:00:00.000Z", "contested", 0.92, "source.alpha.old", "1-2"],
    ] as const) {
      await writeNote(
        `entities/alpha-${slug}.md`,
        `Alpha ${title}`,
        "summary without the keyword",
        {
          id: `entity.alpha.${slug}`,
          updatedAt,
          claims: [
            claim(`claim.alpha.db.${slug}`, "Alpha uses PostgreSQL for production writes.", {
              status,
              confidence,
              evidence: [{ sourceId, lines, updatedAt }],
            }),
          ],
        },
      );
    }

    expect(await searchPaths("postgresql")).toEqual([
      "entities/alpha-fresh.md",
      "entities/alpha-stale.md",
    ]);
  });

  it("includes memory results and backfills wiki capacity for all-corpus search", async () => {
    const { config, writeNote } = await createSharedVault("all");
    for (const index of [1, 2, 3, 4, 5]) {
      await writeNote(`entities/alpha-${index}.md`, `Alpha ${index}`, `alpha wiki ${index}`, {
        id: `entity.alpha.${index}`,
      });
    }
    useMemoryManager({
      searchResults: [
        memoryHit("MEMORY.md", 0.9, "memory", {
          startLine: 4,
          endLine: 8,
          citation: "MEMORY.md#L4-L8",
        }),
      ],
    });

    const results = await searchWiki(config, "alpha", {
      appConfig: createAppConfig(),
      maxResults: 5,
    });

    expect(results).toHaveLength(5);
    expect(results.map((result) => result.corpus)).toContain("memory");
    expect(collectWikiResultPaths(results)).toEqual([
      "entities/alpha-1.md",
      "entities/alpha-2.md",
      "entities/alpha-3.md",
      "entities/alpha-4.md",
    ]);
  });

  it("keeps protected session recall inside its trusted corpus (all/wiki)", async () => {
    const { config, writeNote } = await createSharedVault("all");
    await writeNote("sources/alpha.md", "Alpha", "alpha wiki secret");
    const manager = mockRecallManager();

    const results = await searchWiki(config, "alpha", {
      appConfig: createSessionVisibilityAppConfig(),
      agentId: "main",
      agentSessionKey: RECALL_SESSION_KEY,
      conversationRecall: CONVERSATION_RECALL,
      searchCorpus: "wiki",
    });

    expect(results.map((result) => result.path)).toEqual(["sessions/prior-session.jsonl"]);
    expect(manager.search).toHaveBeenCalledWith("alpha", {
      maxResults: 10,
      sources: ["sessions"],
      sessionKey: RECALL_SESSION_KEY,
    });
  });

  it("keeps context-free shared searches and reads inside the default agent", async () => {
    const { config } = await createSharedVault("memory");
    mockSessionStore({
      "agent:main:visible-session": {
        sessionId: "visible-session",
        updatedAt: 1,
        sessionFile: "/tmp/visible-session.jsonl",
      },
    });
    const manager = useMemoryManager({
      searchResults: [
        memoryHit("sessions/visible-session.jsonl", 2),
        memoryHit("sessions/secondary/private-session.jsonl", 1),
      ],
    });
    const appConfig = createAgentSessionVisibilityAppConfig();

    const results = await searchWiki(config, "transcript", { appConfig });
    const forbiddenPage = await readWiki(config, "sessions/secondary/private-session.jsonl", {
      appConfig,
    });

    expect(results.map((result) => result.path)).toEqual(["sessions/visible-session.jsonl"]);
    expect(forbiddenPage).toBeNull();
    expect(manager.readFile).not.toHaveBeenCalled();
  });

  it.each(["search", "get"] as const)(
    "requires appConfig for session-bound shared memory %s",
    async (operation) => {
      const { config } = await createSharedVault("memory");
      const caller = { config, agentSessionKey: "agent:main:child-session", sandboxed: true };
      const pending =
        operation === "search"
          ? searchMemoryWiki({ ...caller, query: "transcript" })
          : getMemoryWikiPage({ ...caller, lookup: "sessions/child-session.jsonl" });
      await expect(pending).rejects.toThrow(`wiki_${operation} requires appConfig`);
    },
  );

  it("allows per-call corpus overrides without changing config defaults", async () => {
    const { config, writeNote } = await createSharedVault("wiki");
    await writeNote("sources/alpha.md", "Alpha Source", "alpha body text");
    useMemoryManager({
      searchResults: [memoryHit("MEMORY.md", 99, "memory")],
    });

    const memoryOnly = await searchWiki(config, "alpha", {
      appConfig: createAppConfig(),
      searchCorpus: "memory",
    });

    expect(memoryOnly.map((result) => result.corpus)).toEqual(["memory"]);
  });
});

describe("getMemoryWikiPage", () => {
  it.each(["search", "readFile"] as const)(
    "reports a missing manager %s contract",
    async (method) => {
      const { config } = await createSharedVault("memory");
      getActiveMemorySearchManagerMock.mockResolvedValue({ manager: {} });
      const options = { appConfig: createAppConfig() };
      const pending =
        method === "search"
          ? searchWiki(config, "alpha", options)
          : readWiki(config, "MEMORY.md", options);
      await expect(pending).rejects.toThrow(
        `does not implement ${method}() from the MemorySearchManager contract`,
      );
    },
  );

  it("returns provenance for imported wiki source pages", async () => {
    const { config, writeNote } = await createQueryVault();
    await writeNote("sources/imported-source-alpha.md", "Unsafe Alpha", "secret alpha", {
      id: "source.unsafe.alpha",
      sourceType: "memory-unsafe-local",
      provenanceMode: "unsafe-local",
      sourcePath: "/tmp/private/alpha.md",
      unsafeLocalConfiguredPath: "/tmp/private",
      unsafeLocalRelativePath: "alpha.md",
      updatedAt: "2026-04-05T13:00:00.000Z",
    });

    const result = await readWiki(config, "sources/imported-source-alpha.md");

    expect(result).toMatchObject({
      corpus: "wiki",
      path: "sources/imported-source-alpha.md",
      sourceType: "memory-unsafe-local",
      provenanceMode: "unsafe-local",
      sourcePath: "/tmp/private/alpha.md",
      provenanceLabel: "unsafe-local: alpha.md",
      updatedAt: "2026-04-05T13:00:00.000Z",
    });
  });

  it.each(["not_found", "ok"] as const)(
    "distinguishes %s from empty memory files",
    async (status) => {
      const { config } = await createSharedVault("memory");
      const lookup = "memory/empty.md";
      useMemoryManager({
        readResult:
          status === "ok"
            ? { status, path: lookup, text: "", from: 1, lines: 0 }
            : { status, path: lookup, text: "" },
      });
      const result = await createWikiGetTool(config, createAppConfig()).execute("get", {
        lookup,
        fromLine: Number.NaN,
        lineCount: Number.POSITIVE_INFINITY,
      });
      if (status === "ok") {
        expect(result.details).toMatchObject({
          found: true,
          path: lookup,
          content: "",
          fromLine: 1,
          lineCount: 200,
        });
      } else {
        expect(result.details).toEqual({ found: false });
        expect(result.content).toEqual([{ type: "text", text: `Wiki page not found: ${lookup}` }]);
      }
    },
  );

  it("reports a clean error instead of crashing for malformed wiki_get params", async () => {
    const { config } = await createSharedVault("memory");
    const tool = createWikiGetTool(config, createAppConfig());
    const malformedParams = [
      null,
      { path: "sources/example/note.md" },
      { lookup: "   " },
      { lookup: 42 },
    ];

    for (const params of malformedParams) {
      const result = await tool.execute("wiki-get-bad-param", params);

      expect(result.details).toEqual({ found: false });
      expect(result.content).toEqual([
        { type: "text", text: "wiki_get requires a non-empty `lookup` path or id." },
      ]);
    }
  });

  it("does not expose indexed session transcripts through wiki_get", async () => {
    const { config } = await createSharedVault("memory");
    mockSessionStore({
      "agent:main:child-session": {
        sessionId: "child-session",
        updatedAt: 1,
        sessionFile: "/tmp/openclaw/child-session.jsonl",
      },
    });
    const manager = useMemoryManager();

    const result = await readWiki(config, "sessions/main/child-session.jsonl", {
      appConfig: createSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
    });

    expect(result).toBeNull();
    expect(manager.readFile).not.toHaveBeenCalled();
  });
});

describe("wiki corpus bridge page agent scoping", () => {
  async function createBridgeVisibilityVault() {
    const vault = await createQueryVault({
      initialize: true,
      config: { vault: { scope: "global" } },
    });
    for (const [owner, title, agentIds] of [
      ["main", "Main", ["Main"]],
      ["secondary", "Secondary", ["secondary"]],
      ["unowned", "Unowned", []],
    ] as const) {
      await vault.writePage(
        `sources/${owner}-daily-note.md`,
        `${title} Daily Note`,
        `# ${title} Daily Note\n\nwikiscope marker ${owner}\n`,
        {
          sourceType: "memory-bridge",
          sourcePath: `/tmp/workspace/${owner}-daily-note.md`,
          bridgeRelativePath: `${owner}-daily-note.md`,
          bridgeWorkspaceDir: "/tmp/workspace",
          bridgeAgentIds: agentIds,
        },
      );
    }
    await vault.writeNote("sources/shared-note.md", "Shared Note", "wikiscope marker shared");
    return vault;
  }

  it("resolves sandboxed ownership from the session key and fails closed without it", async () => {
    const { config } = await createBridgeVisibilityVault();
    const readAs = (lookup: string, agent: string) =>
      readWiki(config, lookup, {
        appConfig: createAgentSessionVisibilityAppConfig(),
        agentSessionKey: `agent:${agent}:child-session`,
        sandboxed: true,
      });
    const normalizedOwner = await readAs("main-daily-note", "main");
    const denied = await readAs("secondary-daily-note", "main");
    const allowed = await readAs("secondary-daily-note", "secondary");
    const unresolved = await readWiki(config, "secondary-daily-note", { sandboxed: true });

    expect(normalizedOwner?.content).toContain("wikiscope marker main");
    expect(denied).toBeNull();
    expect(allowed?.content).toContain("wikiscope marker secondary");
    expect(unresolved).toBeNull();
  });

  it("filters cross-agent bridge pages out of wiki search results", async () => {
    const { config } = await createBridgeVisibilityVault();
    const scoped = await searchWiki(config, "wikiscope marker", {
      appConfig: createAgentSessionVisibilityAppConfig(),
      agentId: "main",
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
    });
    const unscoped = await searchWiki(config, "wikiscope marker");

    expect(collectWikiResultPaths(scoped).toSorted()).toEqual([
      "sources/main-daily-note.md",
      "sources/shared-note.md",
    ]);
    expect(collectWikiResultPaths(unscoped).toSorted()).toEqual([
      "sources/main-daily-note.md",
      "sources/secondary-daily-note.md",
      "sources/shared-note.md",
      "sources/unowned-daily-note.md",
    ]);
  });
});
registerSessionlessAgentScopeQueryTests({
  createQueryVault,
  createAppConfig: createAgentSessionVisibilityAppConfig,
  createMemoryManager,
  getActiveMemorySearchManagerMock,
  loadMemorySearchSessionStoreMock,
  searchMemoryWiki,
});

const ANCHOR_SESSION_KEY = "agent:main:telegram:direct:owner";
const RECALL_SESSION_KEY = `${ANCHOR_SESSION_KEY}:active-memory:abcdef123456`;
const CONVERSATION_RECALL = {
  anchorSessionKey: ANCHOR_SESSION_KEY,
  scope: "same-agent-private",
  corpus: "sessions",
} as const;

const session = (sessionId: string, updatedAt: number, chatType = "direct") => ({
  sessionId,
  updatedAt,
  chatType,
});
const RECALL_SESSION_STORE = {
  [ANCHOR_SESSION_KEY]: session("current", 4),
  "agent:main:telegram:direct:prior": session("prior-session", 3),
  "agent:main:telegram:group:team": session("team-session", 2, "group"),
  "agent:secondary:telegram:direct:other": session("other-agent", 1),
};

function mockRecallManager() {
  mockSessionStore(RECALL_SESSION_STORE);
  return useMemoryManager({
    searchResults: [
      memoryHit("sessions/prior-session.jsonl", 50),
      memoryHit("sessions/current.jsonl", 40),
      memoryHit("sessions/team-session.jsonl", 30),
      memoryHit("sessions/secondary/other-agent.jsonl", 20),
      memoryHit("MEMORY.md", 10, "memory"),
    ],
  });
}

it("enforces self visibility without a conversation recall grant", async () => {
  const { config } = await createSharedVault("memory");
  mockRecallManager();
  const results = await searchWiki(config, "transcript", {
    appConfig: createSessionVisibilityAppConfig(),
    agentId: "main",
    agentSessionKey: ANCHOR_SESSION_KEY,
    sandboxed: false,
    maxResults: 10,
  });
  expect(results.map((result) => result.path)).toEqual(["sessions/current.jsonl", "MEMORY.md"]);
});

describe("native provider records", () => {
  const createInput = async (corpus: "memory" | "all" = "memory") => ({
    ...(await createSharedVault(corpus)),
    appConfig: createAppConfig(),
  });
  function useProvider<T extends object>(provider: T): T {
    isActiveMemoryProviderNativeMock.mockResolvedValue(true);
    getActiveMemoryProviderMock.mockResolvedValue({
      provider,
      providerId: "knowledge",
      adapter: "native",
    });
    return provider;
  }
  it.each([
    ["legacy manager", false],
    ["native provider", true],
  ])("keeps wiki results when the %s cannot be opened", async (_label, native) => {
    const { writeNote, ...input } = await createInput("all");
    await writeNote("entities/alpha.md", "Alpha", "alpha wiki");
    if (native) {
      isActiveMemoryProviderNativeMock.mockResolvedValue(true);
    }
    getActiveMemorySearchManagerMock.mockRejectedValue(new Error("plugin failed to load"));
    getActiveMemoryProviderMock.mockRejectedValue(new Error("plugin failed to load"));

    const results = await searchMemoryWiki({ ...input, query: "alpha", maxResults: 5 });

    expect(results.map((result) => result.corpus)).toEqual(["wiki"]);
  });
  it.each([
    ["search", false],
    ["get", false],
    ["search", true],
  ] as const)(
    "rejects revoked %s authority (during search: %s) and closes the capability",
    async (operation, duringSearch) => {
      const input = await createInput();
      let current = true;
      const reference = { providerId: "knowledge", id: "private:record" };
      const provider = useProvider({
        search: vi.fn(async () => {
          if (duringSearch) {
            current = false;
          }
          return { hits: duringSearch ? [] : [{ reference, excerpt: "private" }] };
        }),
        ...(!duringSearch && {
          get: vi.fn().mockResolvedValue({ status: "ok", reference, text: "private" }),
        }),
        close: vi.fn(async () => {
          if (!duringSearch) {
            await Promise.resolve();
            current = false;
          }
        }),
      });
      const authorizedInput = {
        ...input,
        memoryContext: {
          authority: duringSearch
            ? { kind: "session" as const, sessionKey: "agent:main:main", sandboxed: false }
            : { kind: "host" as const, operation: "test.query" },
          assertCurrent() {
            if (!current) {
              throw new Error(duringSearch ? "caller revoked" : "caller revoked during cleanup");
            }
          },
        },
      };
      const pending =
        operation === "search"
          ? searchMemoryWiki({ ...authorizedInput, query: "private" })
          : getMemoryWikiPage({
              ...authorizedInput,
              lookup: `memory-ref:${encodeURIComponent(JSON.stringify(reference))}`,
            });
      await expect(pending).rejects.toThrow(
        duringSearch ? "caller revoked" : "caller revoked during cleanup",
      );
      expect(provider.close).toHaveBeenCalledTimes(1);
      current = true;
      const context = getActiveMemoryProviderMock.mock.calls[0]?.[0].context;
      expect(() => context.assertCurrent()).toThrow("query has completed");
    },
  );

  it("round-trips a record-only result with revision and citations without inventing a path", async () => {
    const input = await createInput();
    const reference = {
      providerId: "knowledge",
      id: "claim:release:42",
      revision: "r3",
      fragment: "evidence:1",
    };
    const citations = [
      { label: "Release decision", reference, url: "https://example.test/source/42" },
    ];
    const provider = useProvider({
      search: vi.fn().mockResolvedValue({
        hits: [{ reference, excerpt: "Release on Friday", citations, score: 0.9 }],
      }),
      get: vi.fn().mockResolvedValue({
        status: "ok",
        reference,
        text: "Release on Friday, after review.",
        citations,
        truncated: true,
        from: 2,
        lines: 4,
      }),
      close: vi.fn(),
    });
    const results = await searchMemoryWiki({ ...input, query: "release" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reference, citations, title: "Release decision" });
    expect(results[0]).not.toHaveProperty("path");
    const lookup = results[0]?.lookup;
    if (!lookup) {
      throw new Error("Expected provider lookup");
    }
    const record = await getMemoryWikiPage({ ...input, lookup, fromLine: 2, lineCount: 4 });
    expect(provider.get).toHaveBeenCalledExactlyOnceWith({ reference, from: 2, lines: 4 });
    expect(record).toMatchObject({
      reference,
      citations,
      content: "Release on Friday, after review.",
      truncated: true,
    });
    expect(record).not.toHaveProperty("path");
    expect(provider.close).toHaveBeenCalledTimes(2);
    expect(getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("releases a denied provider read without retrying it as a path", async () => {
    const input = await createInput();
    const reference = { providerId: "knowledge", id: "private:record" };
    const provider = useProvider({
      get: vi.fn().mockRejectedValue(new Error("not authorized")),
      close: vi.fn(),
    });
    const lookup = `memory-ref:${encodeURIComponent(JSON.stringify(reference))}`;
    await expect(getMemoryWikiPage({ ...input, lookup })).rejects.toThrow("not authorized");
    expect(provider.get).toHaveBeenCalledTimes(1);
    expect(provider.close).toHaveBeenCalledTimes(1);
  });
});
