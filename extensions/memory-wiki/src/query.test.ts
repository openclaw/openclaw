import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { filterMemorySearchHitsBySessionVisibility } from "@openclaw/memory-core/session-search-visibility-api.js";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { compileMemoryWikiVault } from "./compile.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { registerConversationRecallQueryTests } from "./query.conversation-recall.test-support.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { registerProviderRecordQueryTests } from "./query.provider-runtime.test-support.js";
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
let suiteRoot = "";
let caseIndex = 0;

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

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-query-suite-"));
});

afterAll(async () => {
  if (suiteRoot) {
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
});

async function createQueryVault(options?: {
  config?: MemoryWikiPluginConfig;
  initialize?: boolean;
}) {
  const vault = await createVault({
    prefix: "memory-wiki-query-",
    rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
    initialize: options?.initialize ?? true,
    config: options?.config,
  });
  return {
    ...vault,
    writePage: writeVaultPage.bind(null, vault.rootDir),
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
      "agent:main:sibling-session": {
        sessionId: "sibling-session",
        updatedAt: 2,
        sessionFile: "/tmp/openclaw/sibling-session.jsonl",
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
    status: vi.fn().mockReturnValue({ backend: "builtin", provider: "builtin" }),
    probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
    probeVectorAvailability: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("searchMemoryWiki", () => {
  it("skips malformed pages while searching the rest of the vault (#96125)", async () => {
    const { rootDir, config, writePage } = await createQueryVault();
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
    await writePage("sources/healthy.md", "Healthy Source", "# Healthy Source\n\nhealthy needle\n");

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
    const { config, writePage } = await createQueryVault();
    const pages = [
      ["ru", "Альфа — это новый внутренний проект."],
      ["ja", "会議は来週東京で開きます。"],
      ["de", "Die Straße gehört Herrn Müller."],
      ["controller", "The controller strategy is documented here."],
    ] as const;
    for (const [slug, body] of pages) {
      await writePage(`entities/${slug}.md`, `Notes ${slug}`, `# Notes ${slug}\n\n${body}\n`, {
        id: `entity.${slug}`,
      });
    }

    const search = async (query: string) =>
      (await searchWiki(config, query, { maxResults: 10 })).map((result) => result.path);

    expect(await search("проект альфа")).toEqual(["entities/ru.md"]);
    expect(await search("東京 会議")).toEqual(["entities/ja.md"]);
    expect(await search("Müller Straße")).toEqual(["entities/de.md"]);
  });

  it("supports people-routing search modes and claim evidence drilldown metadata", async () => {
    const { config, writePage } = await createQueryVault();
    await writePage("entities/brad.md", "Brad Groux", "# Brad Groux\n\nAgent card summary.\n", {
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
    await writePage(
      "sources/maintainers.md",
      "Maintainers Source",
      "# Maintainers Source\n\nmaintainer-whois Teams sample.\n",
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
    const { config, writePage } = await createQueryVault();
    await writePage("entities/brad.md", "Brad Groux", "# Brad Groux\n\nAgent card summary.\n", {
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
    await writePage(
      "entities/fallback.md",
      "Fallback Router",
      "# Fallback Router\n\nGeneric routing note.\n",
      { bestUsedFor: ["Azure escalation buddy"] },
    );
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
    const { config, writePage } = await createQueryVault();
    for (const [slug, title, updatedAt, status, confidence, sourceId, lines] of [
      ["fresh", "Fresh", "2026-04-01T00:00:00.000Z", "supported", 0.91, "source.alpha", "4-7"],
      ["stale", "Stale", "2025-10-01T00:00:00.000Z", "contested", 0.92, "source.alpha.old", "1-2"],
    ] as const) {
      await writePage(
        `entities/alpha-${slug}.md`,
        `Alpha ${title}`,
        `# Alpha ${title}\n\nsummary without the keyword\n`,
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

    expect(results).toHaveLength(2);
    expect(results[0]?.path).toBe("entities/alpha-fresh.md");
    expect(results[1]?.path).toBe("entities/alpha-stale.md");
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
    const { config, writePage } = await createSharedVault("all");
    for (const index of [1, 2, 3, 4, 5]) {
      await writePage(
        `entities/alpha-${index}.md`,
        `Alpha ${index}`,
        `# Alpha ${index}\n\nalpha wiki ${index}\n`,
        { id: `entity.alpha.${index}` },
      );
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

  it("filters session memory hits outside the caller visibility policy", async () => {
    const { config } = await createSharedVault("memory");
    mockSessionTranscriptStore();
    const manager = createMemoryManager({
      searchResults: [
        memoryHit("sessions/child-session.jsonl", 30),
        memoryHit("sessions/main/sibling-session.jsonl", 20),
        memoryHit("MEMORY.md", 10, "memory"),
      ],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

    const results = await searchWiki(config, "transcript", {
      appConfig: createSessionVisibilityAppConfig(),
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
      maxResults: 10,
    });

    expect(results.map((result) => result.path)).toEqual([
      "sessions/child-session.jsonl",
      "MEMORY.md",
    ]);
  });

  it("keeps protected session recall inside its trusted corpus (all/wiki)", async () => {
    const { config, writePage } = await createSharedVault("all");
    await writePage("sources/alpha.md", "Alpha", "# Alpha\n\nalpha wiki secret\n");
    const anchorSessionKey = "agent:main:telegram:direct:owner";
    const requesterSessionKey = `${anchorSessionKey}:active-memory:abcdef123456`;
    loadCombinedSessionStoreForGatewayAsyncMock.mockResolvedValue({
      storePath: "(test)",
      store: {
        [anchorSessionKey]: {
          sessionId: "current",
          updatedAt: 1,
          sessionFile: "/tmp/current.jsonl",
          chatType: "direct",
        },
      },
    });
    const manager = createMemoryManager({
      searchResults: [memoryHit("MEMORY.md", 1, "memory")],
    });
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager });
    const conversationRecall = {
      anchorSessionKey,
      scope: "same-agent-private",
      corpus: "sessions",
    } as const;

    const results = await searchWiki(config, "alpha", {
      appConfig: createSessionVisibilityAppConfig(),
      agentId: "main",
      agentSessionKey: requesterSessionKey,
      conversationRecall,
      searchCorpus: "wiki",
    });

    expect(results).toStrictEqual([]);
    expect(manager.search).toHaveBeenCalledWith("alpha", {
      maxResults: 10,
      sources: ["sessions"],
      sessionKey: requesterSessionKey,
    });
    expect(filterMemorySearchHitsBySessionVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationRecall,
        hits: [expect.objectContaining({ source: "memory" })],
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
    const { config, writePage } = await createSharedVault("wiki");
    await writePage("sources/alpha.md", "Alpha Source", "# Alpha Source\n\nalpha body text\n");
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
  it("returns provenance for imported wiki source pages", async () => {
    const { config, writePage } = await createQueryVault();
    await writePage(
      "sources/imported-source-alpha.md",
      "Unsafe Alpha",
      "# Unsafe Alpha\n\nsecret alpha\n",
      {
        id: "source.unsafe.alpha",
        sourceType: "memory-unsafe-local",
        provenanceMode: "unsafe-local",
        sourcePath: "/tmp/private/alpha.md",
        unsafeLocalConfiguredPath: "/tmp/private",
        unsafeLocalRelativePath: "alpha.md",
        updatedAt: "2026-04-05T13:00:00.000Z",
      },
    );

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
    await vault.writePage(
      "sources/shared-note.md",
      "Shared Note",
      "# Shared Note\n\nwikiscope marker shared\n",
    );
    return vault;
  }

  it("limits sandboxed bridge reads to pages owned by the caller", async () => {
    const { config } = await createBridgeVisibilityVault();
    const caller = {
      config,
      appConfig: createAgentSessionVisibilityAppConfig(),
      agentId: "main",
      sandboxed: true,
    };

    const read = (lookup: string) => getMemoryWikiPage({ ...caller, lookup });
    const owned = await read("main-daily-note");
    const shared = await read("shared-note");
    const foreign = await read("secondary-daily-note");
    const unowned = await read("unowned-daily-note");

    expect(owned?.content).toContain("wikiscope marker main");
    expect(shared?.content).toContain("wikiscope marker shared");
    expect(foreign).toBeNull();
    expect(unowned).toBeNull();
  });

  it("resolves sandboxed ownership from the session key and fails closed without it", async () => {
    const { config } = await createBridgeVisibilityVault();
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
registerConversationRecallQueryTests({
  createQueryVault,
  getActiveMemorySearchManagerMock,
  loadCombinedSessionStoreForGatewayAsyncMock,
  searchMemoryWiki,
});
registerProviderRecordQueryTests({
  createQueryVault,
  createAppConfig,
  getActiveMemoryProviderMock,
  getActiveMemorySearchManagerMock,
  useNativeProvider: () => isActiveMemoryProviderNativeMock.mockResolvedValue(true),
  searchMemoryWiki,
  getMemoryWikiPage,
});
