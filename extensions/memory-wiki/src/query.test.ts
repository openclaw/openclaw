import fs from "node:fs/promises";
import path from "node:path";
import { filterMemorySearchHitsBySessionVisibility } from "@openclaw/memory-core/session-search-visibility-api.js";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { registerSessionlessAgentScopeQueryTests } from "./query.session-scope.test-support.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiGetTool } from "./tool.js";

const {
  getActiveMemorySearchManagerMock,
  getActiveMemoryProviderMock,
  isActiveMemoryProviderNativeMock,
  loadCombinedSessionStoreForGatewayAsyncMock,
  resolveDefaultAgentIdMock,
  resolveSessionAgentIdMock,
} = vi.hoisted(() => ({
  getActiveMemorySearchManagerMock: vi.fn(),
  getActiveMemoryProviderMock: vi.fn(),
  isActiveMemoryProviderNativeMock: vi.fn(),
  loadCombinedSessionStoreForGatewayAsyncMock: vi.fn(),
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

vi.mock("@openclaw/memory-core/session-search-visibility-api.js", { spy: true });

vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  resolveSessionAgentIdStrict: resolveSessionAgentIdMock,
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGatewayAsync: loadCombinedSessionStoreForGatewayAsyncMock,
  };
});

function managedBlock(kind: string, body = "") {
  return `<!-- openclaw:${kind}:start -->\n${body ? body + "\n" : ""}<!-- openclaw:${kind}:end -->`;
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
  loadCombinedSessionStoreForGatewayAsyncMock
    .mockReset()
    .mockResolvedValue({ storePath: "(test)", store: {} });
  resolveDefaultAgentIdMock.mockClear();
  resolveSessionAgentIdMock.mockClear();
  vi.mocked(filterMemorySearchHitsBySessionVisibility).mockClear();
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
    writePage: writeVaultPage.bind(null, vault.rootDir),
    writeNote: (relativePath: string, title: string, text: string, fields = {}) =>
      writeVaultPage(vault.rootDir, relativePath, title, `# ${title}\n\n${text}\n`, fields),
  };
}

function createSharedVault(corpus: "all" | "wiki" | "memory") {
  return createQueryVault({ config: { search: { backend: "shared", corpus } } });
}

function createAppConfig(): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
  } as OpenClawConfig;
}

function createSessionVisibilityAppConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: { sandbox: { sessionToolsVisibility: "all" } },
      entries: { main: {} },
    },
    tools: {
      sessions: { visibility: "self" },
    },
  } as OpenClawConfig;
}

function createAgentSessionVisibilityAppConfig(): OpenClawConfig {
  return {
    agents: { entries: { main: {}, secondary: {} } },
    tools: { sessions: { visibility: "agent" } },
  } as OpenClawConfig;
}

function mockSessionTranscriptStore() {
  loadCombinedSessionStoreForGatewayAsyncMock.mockResolvedValue({
    storePath: "(test)",
    store: {
      "agent:main:child-session": {
        sessionId: "child-session",
        updatedAt: 1,
        sessionFile: "/tmp/openclaw/child-session.jsonl",
      },
    },
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

describe("searchMemoryWiki", () => {
  it("skips malformed pages while searching the rest of the vault (#96125)", async () => {
    const { rootDir, config, writeNote } = await createQueryVault();
    await fs.writeFile(
      path.join(rootDir, "sources", "broken.md"),
      [
        "---",
        "pageType: source",
        "id: source.broken",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
        "---",
        "",
        "# Broken",
        "",
        "poison needle",
      ].join("\n"),
      "utf8",
    );
    await writeNote("sources/healthy.md", "Healthy Source", "healthy needle");

    const results = await searchWiki(config, "needle", { maxResults: Number.NaN });

    expect(collectWikiResultPaths(results)).toEqual(["sources/healthy.md"]);
  });

  it("does not match generated related blocks during wiki search", async () => {
    const { config, writePage } = await createQueryVault();
    await writePage(
      "entities/alpha.md",
      "Alpha",
      "# Alpha\n\nAlpha body.\n\n## Related\n" +
        managedBlock(
          "wiki:related",
          "### Related Pages\n- [Needle Person](entities/needle-person.md)",
        ) +
        "\n",
      { sourceIds: ["source.alpha"] },
    );
    await writePage(
      "entities/needle-person.md",
      "Needle Person",
      "# Needle Person\n\nNeedle body.\n",
      { sourceIds: ["source.alpha"] },
    );

    const results = await searchWiki(config, "Needle Person", { maxResults: 10 });

    expect(results.map((result) => result.path)).toEqual(["entities/needle-person.md"]);
  });

  it("filters standalone structural markers from matching, snippets, and ranking", async () => {
    const { config, writePage } = await createQueryVault();
    await Promise.all([
      writePage(
        "entities/marker-only.md",
        "Marker Only",
        managedBlock("wiki:generated") +
          "\n" +
          managedBlock("human") +
          "\n<!-- openclaw:wiki:raw-source -->\n",
      ),
      writePage(
        "entities/evidence.md",
        "Evidence Page",
        managedBlock("human", "# Evidence Page\n\nReadable release evidence summary.") + "\n",
        {
          description: "openclaw release evidence",
          claims: [
            {
              id: "claim.evidence",
              text: "Neutral release note.",
              status: "supported",
              confidence: 0.8,
              evidence: [{ note: "supporting reference" }],
            },
          ],
        },
      ),
      writePage(
        "entities/marker-heavy.md",
        "Marker Heavy",
        "# Marker Heavy\n\n" +
          managedBlock("wiki:generated", "openclaw body reference") +
          "\n" +
          managedBlock("human") +
          "\n<!-- openclaw:wiki:raw-source -->\n",
      ),
      writePage("entities/clean.md", "Clean", "# Clean\n\nopenclaw openclaw body reference\n"),
    ]);

    const evidenceResults = await searchWiki(config, "openclaw release", { maxResults: 10 });
    expect(evidenceResults.map((result) => result.path)).toEqual(["entities/evidence.md"]);
    expect(evidenceResults[0]?.snippet).toBe("Readable release evidence summary.");

    const openClawResults = await searchWiki(config, "openclaw", { maxResults: 10 });
    const paths = openClawResults.map((result) => result.path);
    expect(paths).not.toContain("entities/marker-only.md");
    expect(
      openClawResults.find((result) => result.path === "entities/clean.md")?.score,
    ).toBeGreaterThan(
      openClawResults.find((result) => result.path === "entities/marker-heavy.md")?.score ?? 0,
    );
  });

  it("keeps managed-block content and inline marker prose searchable", async () => {
    const { config, writePage } = await createQueryVault();
    await Promise.all([
      writePage(
        "entities/managed-content.md",
        "Managed Content",
        "# Managed Content\n\n" +
          managedBlock("wiki:generated", "Cobalt content remains searchable.") +
          "\n",
      ),
      writePage(
        "entities/inline-marker.md",
        "Inline Marker",
        "# Inline Marker\n\nThe literal <!-- openclaw:wiki:generated:start --> inline-needle stays searchable.\n",
      ),
    ]);

    const managedResults = await searchWiki(config, "cobalt");
    expect(managedResults.map((result) => result.path)).toEqual(["entities/managed-content.md"]);
    expect(managedResults[0]?.snippet).toBe("Cobalt content remains searchable.");

    const inlineResults = await searchWiki(config, "inline-needle");
    expect(inlineResults.map((result) => result.path)).toEqual(["entities/inline-marker.md"]);
    expect(inlineResults[0]?.snippet).toContain("<!-- openclaw:wiki:generated:start -->");
  });

  it("matches non-ASCII query terms without an exact phrase", async () => {
    const { config, writeNote } = await createQueryVault();
    const pages = [
      ["ru", "Альфа — это новый внутренний проект."],
      ["ja", "会議は来週東京で開きます。"],
      ["de", "Die Straße gehört Herrn Müller."],
      ["controller", "The controller strategy is documented here."],
    ] as const;
    for (const [slug, body] of pages) {
      await writeNote(`entities/${slug}.md`, `Notes ${slug}`, body);
    }

    const search = async (query: string) =>
      (await searchWiki(config, query, { maxResults: 10 })).map((result) => result.path);

    expect(await search("проект альфа")).toEqual(["entities/ru.md"]);
    expect(await search("東京 会議")).toEqual(["entities/ja.md"]);
    expect(await search("Müller Straße")).toEqual(["entities/de.md"]);
  });

  it("supports people-routing search modes and claim evidence drilldown metadata", async () => {
    const { config, writeNote } = await createQueryVault();
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
        {
          targetId: "entity.alice",
          targetTitle: "Alice",
          kind: "works-with",
          note: "Teams escalation buddy",
        },
      ],
      claims: [
        {
          id: "claim.brad.teams",
          text: "Brad is a strong route for Microsoft Teams questions.",
          status: "supported",
          confidence: 0.88,
          evidence: [
            {
              kind: "maintainer-whois",
              sourceId: "source.maintainers",
              privacyTier: "local-private",
            },
          ],
        },
      ],
    });
    await writeNote(
      "sources/maintainers.md",
      "Maintainers Source",
      "maintainer-whois Teams sample.",
    );
    await compileMemoryWikiVault(config);

    const personResults = await searchWiki(config, "bgroux", { mode: "find-person" });
    expect(personResults[0]).toMatchObject({
      path: "entities/brad.md",
      canonicalId: "maintainer.brad-groux",
      aliases: ["bgroux"],
      privacyTier: "local-private",
      searchMode: "find-person",
    });

    const routeResults = await searchWiki(config, "who should I ask about Teams?", {
      mode: "route-question",
    });
    expect(routeResults[0]?.path).toBe("entities/brad.md");

    const claimResults = await searchWiki(config, "strong route Teams", { mode: "raw-claim" });
    expect(claimResults[0]).toMatchObject({
      path: "entities/brad.md",
      matchedClaimId: "claim.brad.teams",
      matchedClaimConfidence: 0.88,
      evidenceKinds: ["maintainer-whois"],
      evidenceSourceIds: ["source.maintainers"],
    });

    const evidenceResults = await searchWiki(config, "maintainer-whois", {
      mode: "source-evidence",
      maxResults: 5,
    });
    expect(evidenceResults.map((result) => result.path)).toContain("sources/maintainers.md");
  });

  it("keeps route-question relationship matches in compiled digest prefilter", async () => {
    const { config, writeNote } = await createQueryVault();
    await writeNote("entities/brad.md", "Brad Groux", "Agent card summary.", {
      entityType: "person",
      relationships: [
        {
          targetId: "entity.alice",
          targetTitle: "Alice",
          kind: "collaborates-with",
          note: "Azure escalation buddy",
        },
      ],
    });
    await writeNote("entities/fallback.md", "Fallback Router", "Generic routing note.", {
      bestUsedFor: ["Azure escalation buddy"],
    });
    await compileMemoryWikiVault(config);

    const routeResults = await searchWiki(
      config,
      "who should I ask about Azure escalation buddy?",
      { mode: "route-question", maxResults: 1 },
    );

    expect(routeResults[0]?.path).toBe("entities/brad.md");
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
      const { config, writePage } = await createQueryVault();
      await writePage(
        "entities/bounded-snippet.md",
        "Bounded Snippet",
        source === "claim" ? "# Bounded Snippet\n\nUnrelated body.\n" : `# Wiki\n\n${text}\n`,
        source === "claim"
          ? {
              claims: [
                {
                  id: "claim.bounded-snippet",
                  text,
                  status: "supported",
                  confidence: 0.9,
                  evidence: [],
                },
              ],
            }
          : {},
      );

      const results = await searchWiki(config, "needle");

      expect(results).toHaveLength(1);
      expect(results[0]?.snippet).toBe(expected);
      expect(results[0]?.snippet.length).toBeLessThanOrEqual(700);
    },
  );

  it("ranks fresh supported claims ahead of stale contested claims", async () => {
    const { config, writeNote } = await createQueryVault();
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
            {
              id: `claim.alpha.db.${slug}`,
              text: "Alpha uses PostgreSQL for production writes.",
              status,
              confidence,
              evidence: [{ sourceId, lines, updatedAt }],
            },
          ],
        },
      );
    }

    const results = await searchWiki(config, "postgresql");

    expect(results.map((result) => result.path)).toEqual([
      "entities/alpha-fresh.md",
      "entities/alpha-stale.md",
    ]);
  });

  it("reports a contract error when the shared manager lacks search()", async () => {
    const { config } = await createSharedVault("all");
    // Partial manager as registered by @mem0/openclaw-mem0 <= 1.0.14.
    const partialManager = {
      status: vi.fn().mockReturnValue({ backend: "builtin", provider: "builtin" }),
      probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager: partialManager });
    await expect(
      searchWiki(config, "alpha", { appConfig: createAppConfig(), maxResults: 5 }),
    ).rejects.toThrow("does not implement search() from the MemorySearchManager contract");
  });

  it("includes memory results and backfills wiki capacity for all-corpus search", async () => {
    const { config, writeNote } = await createSharedVault("all");
    for (const index of [1, 2, 3, 4, 5]) {
      await writeNote(`entities/alpha-${index}.md`, `Alpha ${index}`, `alpha wiki ${index}`, {
        id: `entity.alpha.${index}`,
      });
    }
    const manager = createMemoryManager({
      searchResults: [
        memoryHit("MEMORY.md", 0.9, "memory", {
          startLine: 4,
          endLine: 8,
          citation: "MEMORY.md#L4-L8",
        }),
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

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
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 5 });
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
    expect(filterMemorySearchHitsBySessionVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationRecall: CONVERSATION_RECALL,
        hits: expect.arrayContaining([expect.objectContaining({ source: "memory" })]),
      }),
    );
  });

  it("keeps context-free shared searches and reads inside the default agent", async () => {
    const { config } = await createSharedVault("memory");
    loadCombinedSessionStoreForGatewayAsyncMock.mockResolvedValue({
      storePath: "(test)",
      store: {
        "agent:main:visible-session": {
          sessionId: "visible-session",
          updatedAt: 1,
          sessionFile: "/tmp/visible-session.jsonl",
        },
      },
    });
    const manager = createMemoryManager({
      searchResults: [
        memoryHit("sessions/visible-session.jsonl", 2),
        memoryHit("sessions/secondary/private-session.jsonl", 1),
      ],
      readResult: {
        status: "ok",
        path: "sessions/secondary/private-session.jsonl",
        text: "other agent transcript",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });
    const appConfig = createAgentSessionVisibilityAppConfig();

    const results = await searchWiki(config, "transcript", { appConfig });
    const forbiddenPage = await readWiki(config, "sessions/secondary/private-session.jsonl", {
      appConfig,
    });

    expect(results.map((result) => result.path)).toEqual(["sessions/visible-session.jsonl"]);
    expect(forbiddenPage).toBeNull();
    expect(manager.readFile).not.toHaveBeenCalled();
    expect(loadCombinedSessionStoreForGatewayAsyncMock).toHaveBeenCalledWith(appConfig, {
      agentId: "main",
    });
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
    const manager = createMemoryManager({
      searchResults: [memoryHit("MEMORY.md", 99, "memory")],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const memoryOnly = await searchWiki(config, "alpha", {
      appConfig: createAppConfig(),
      searchCorpus: "memory",
    });

    expect(memoryOnly).toHaveLength(1);
    expect(memoryOnly[0]?.corpus).toBe("memory");
    expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 10 });
  });
});

describe("getMemoryWikiPage", () => {
  it("reports a contract error when the shared manager lacks readFile()", async () => {
    const { config } = await createSharedVault("memory");
    const partialManager = {
      search: vi.fn().mockResolvedValue([]),
      status: vi.fn().mockReturnValue({ backend: "builtin", provider: "builtin" }),
    };
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager: partialManager });
    await expect(readWiki(config, "MEMORY.md", { appConfig: createAppConfig() })).rejects.toThrow(
      "does not implement readFile() from the MemorySearchManager contract",
    );
  });

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

  it("reports genuinely missing shared memory files through the wiki_get tool", async () => {
    const { config } = await createSharedVault("memory");
    const manager = createMemoryManager({
      readResult: { status: "not_found", path: "memory/missing.md", text: "" },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const tool = createWikiGetTool(config, createAppConfig());
    const result = await tool.execute("wiki-get-missing", { lookup: "memory/missing.md" });

    expect(result.details).toEqual({ found: false });
    expect(result.content).toEqual([
      { type: "text", text: "Wiki page not found: memory/missing.md" },
    ]);
  });

  it("keeps existing empty shared memory files distinct from missing files", async () => {
    const { config } = await createSharedVault("memory");
    const manager = createMemoryManager({
      readResult: { status: "ok", path: "memory/empty.md", text: "", from: 1, lines: 0 },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const tool = createWikiGetTool(config, createAppConfig());
    const result = await tool.execute("wiki-get-empty", {
      lookup: "memory/empty.md",
      fromLine: Number.NaN,
      lineCount: Number.POSITIVE_INFINITY,
    });

    expect(result.details).toMatchObject({
      found: true,
      path: "memory/empty.md",
      content: "",
      fromLine: 1,
      lineCount: 200,
    });
  });

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
    mockSessionTranscriptStore();
    const manager = createMemoryManager({
      readResult: {
        status: "ok",
        path: "sessions/main/child-session.jsonl",
        text: "own transcript content",
      },
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

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
    const normalizedOwner = await readWiki(config, "main-daily-note", {
      appConfig: createAgentSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
    });
    const denied = await readWiki(config, "secondary-daily-note", {
      appConfig: createAgentSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
    });
    const allowed = await readWiki(config, "secondary-daily-note", {
      appConfig: createAgentSessionVisibilityAppConfig(),
      agentSessionKey: "agent:secondary:child-session",
      sandboxed: true,
    });
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
  loadCombinedSessionStoreForGatewayAsyncMock,
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
  loadCombinedSessionStoreForGatewayAsyncMock.mockResolvedValue({
    storePath: "(test)",
    store: RECALL_SESSION_STORE,
  });
  const manager = createMemoryManager({
    searchResults: [
      memoryHit("sessions/prior-session.jsonl", 50),
      memoryHit("sessions/current.jsonl", 40),
      memoryHit("sessions/team-session.jsonl", 30),
      memoryHit("sessions/secondary/other-agent.jsonl", 20),
      memoryHit("MEMORY.md", 10, "memory"),
    ],
  });
  getActiveMemorySearchManagerMock.mockResolvedValue({ manager });
  return manager;
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
