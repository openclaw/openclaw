import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../api.js";
import type { MemoryWikiPluginConfig, ResolvedMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import type { getMemoryWikiPage, searchMemoryWiki } from "./query.js";

type QueryVaultFactory = (options: {
  initialize: true;
  config: MemoryWikiPluginConfig;
}) => Promise<{ rootDir: string; config: ResolvedMemoryWikiConfig }>;

type ProviderRecordTestParams = {
  createQueryVault: QueryVaultFactory;
  createAppConfig: () => OpenClawConfig;
  getActiveMemoryProviderMock: Mock;
  getActiveMemorySearchManagerMock: Mock;
  createMemoryManager: (overrides: {
    searchResults?: Array<{
      path: string;
      startLine: number;
      endLine: number;
      score: number;
      snippet: string;
      source: "memory" | "sessions";
    }>;
    readResult?: MemoryReadResult;
  }) => { search: Mock; readFile: Mock };
  /** Selects a slot owner that registers the provider-neutral runtime. */
  useNativeProvider: () => void;
  searchMemoryWiki: typeof searchMemoryWiki;
  getMemoryWikiPage: typeof getMemoryWikiPage;
};

/** Registers owner selection plus provider-neutral record round-trip and caller-currency coverage. */
export function registerProviderRecordQueryTests(params: ProviderRecordTestParams): void {
  describe("shared memory owner selection", () => {
    async function createAlphaVault() {
      const { rootDir, config } = await params.createQueryVault({
        initialize: true,
        config: { search: { backend: "shared", corpus: "all" } },
      });
      await fs.writeFile(
        path.join(rootDir, "entities", "alpha.md"),
        renderWikiMarkdown({
          frontmatter: { pageType: "entity", id: "entity.alpha", title: "Alpha" },
          body: "# Alpha\n\nalpha wiki\n",
        }),
        "utf8",
      );
      return config;
    }

    it("returns legacy hits exactly as the manager produced them", async () => {
      const config = await createAlphaVault();
      const manager = params.createMemoryManager({
        searchResults: [
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 2,
            score: 0.91,
            snippet: "alpha launch. <!-- trigger: alpha launch -->",
            source: "memory",
          },
        ],
      });
      params.getActiveMemorySearchManagerMock.mockResolvedValue({ manager });

      const results = await params.searchMemoryWiki({
        config,
        appConfig: params.createAppConfig(),
        query: "alpha",
        maxResults: 5,
      });

      expect(params.getActiveMemoryProviderMock).not.toHaveBeenCalled();
      expect(manager.search).toHaveBeenCalledWith("alpha", { maxResults: 5 });
      expect(JSON.stringify(results.find((result) => result.corpus === "memory"))).toBe(
        JSON.stringify({
          corpus: "memory",
          path: "MEMORY.md",
          title: "MEMORY",
          kind: "memory",
          score: 0.91,
          snippet: "alpha launch. <!-- trigger: alpha launch -->",
          startLine: 1,
          endLine: 2,
          memorySource: "memory",
          searchMode: "auto",
        }),
      );
    });

    it("resolves a reference-shaped lookup as a path for a legacy owner", async () => {
      const { config } = await params.createQueryVault({
        initialize: true,
        config: { search: { backend: "shared", corpus: "memory" } },
      });
      const manager = params.createMemoryManager({
        readResult: { status: "not_found", text: "", path: "memory-ref" },
      });
      params.getActiveMemorySearchManagerMock.mockResolvedValue({ manager });
      const lookup = `memory-ref:${encodeURIComponent(JSON.stringify({ providerId: "other", id: "x" }))}`;

      await expect(
        params.getMemoryWikiPage({
          config,
          appConfig: params.createAppConfig(),
          lookup: `${lookup}%ZZ`,
        }),
      ).resolves.toBeNull();
      expect(params.getActiveMemoryProviderMock).not.toHaveBeenCalled();
    });

    it.each([
      ["legacy manager", false],
      ["native provider", true],
    ])("keeps wiki results when the %s cannot be opened", async (_label, native) => {
      const config = await createAlphaVault();
      if (native) {
        params.useNativeProvider();
      }
      params.getActiveMemorySearchManagerMock.mockRejectedValue(new Error("plugin failed to load"));
      params.getActiveMemoryProviderMock.mockRejectedValue(new Error("plugin failed to load"));

      const results = await params.searchMemoryWiki({
        config,
        appConfig: params.createAppConfig(),
        query: "alpha",
        maxResults: 5,
      });

      expect(results.map((result) => result.corpus)).toEqual(["wiki"]);
    });
  });

  describe("provider-neutral memory records", () => {
    it.each(["search", "get"] as const)(
      "rejects %s results when cleanup revokes the caller",
      async (operation) => {
        const { config } = await params.createQueryVault({
          initialize: true,
          config: { search: { backend: "shared", corpus: "memory" } },
        });
        let current = true;
        const reference = { providerId: "knowledge", id: "private:record" };
        const provider = {
          search: vi.fn().mockResolvedValue({ hits: [{ reference, excerpt: "private" }] }),
          get: vi.fn().mockResolvedValue({ status: "ok", reference, text: "private" }),
          close: vi.fn(async () => {
            await Promise.resolve();
            current = false;
          }),
        };
        params.useNativeProvider();
        params.getActiveMemoryProviderMock.mockResolvedValue({
          provider,
          providerId: "knowledge",
          adapter: "native",
        });
        const input = {
          config,
          appConfig: params.createAppConfig(),
          memoryContext: {
            authority: { kind: "host" as const, operation: "test.query" },
            assertCurrent() {
              if (!current) {
                throw new Error("caller revoked during cleanup");
              }
            },
          },
        };
        const pending =
          operation === "search"
            ? params.searchMemoryWiki({ ...input, query: "private" })
            : params.getMemoryWikiPage({
                ...input,
                lookup: `memory-ref:${encodeURIComponent(JSON.stringify(reference))}`,
              });
        await expect(pending).rejects.toThrow("caller revoked during cleanup");
        expect(provider.close).toHaveBeenCalledTimes(1);
      },
    );

    it("round-trips a record-only result with revision and citations without inventing a path", async () => {
      const { config } = await params.createQueryVault({
        initialize: true,
        config: { search: { backend: "shared", corpus: "memory" } },
      });
      const reference = {
        providerId: "knowledge",
        id: "claim:release:42",
        revision: "r3",
        fragment: "evidence:1",
      };
      const citations = [
        { label: "Release decision", reference, url: "https://example.test/source/42" },
      ];
      const provider = {
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
      };
      params.useNativeProvider();
      params.getActiveMemoryProviderMock.mockResolvedValue({
        provider,
        providerId: "knowledge",
        adapter: "native",
      });
      const results = await params.searchMemoryWiki({
        config,
        appConfig: params.createAppConfig(),
        query: "release",
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ reference, citations, title: "Release decision" });
      expect(results[0]).not.toHaveProperty("path");
      const lookup = results[0]?.lookup;
      if (!lookup) {
        throw new Error("Expected provider lookup");
      }
      const record = await params.getMemoryWikiPage({
        config,
        appConfig: params.createAppConfig(),
        lookup,
        fromLine: 2,
        lineCount: 4,
      });
      expect(provider.get).toHaveBeenCalledExactlyOnceWith({ reference, from: 2, lines: 4 });
      expect(record).toMatchObject({
        reference,
        citations,
        content: "Release on Friday, after review.",
        truncated: true,
      });
      expect(record).not.toHaveProperty("path");
      expect(provider.close).toHaveBeenCalledTimes(2);
      expect(params.getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
    });

    it("releases a denied provider read without retrying it as a path", async () => {
      const { config } = await params.createQueryVault({
        initialize: true,
        config: { search: { backend: "shared", corpus: "memory" } },
      });
      const reference = { providerId: "knowledge", id: "private:record" };
      const provider = {
        get: vi.fn().mockRejectedValue(new Error("not authorized")),
        close: vi.fn(),
      };
      params.useNativeProvider();
      params.getActiveMemoryProviderMock.mockResolvedValue({
        provider,
        providerId: "knowledge",
        adapter: "native",
      });
      const lookup = `memory-ref:${encodeURIComponent(JSON.stringify(reference))}`;
      await expect(
        params.getMemoryWikiPage({ config, appConfig: params.createAppConfig(), lookup }),
      ).rejects.toThrow("not authorized");
      expect(provider.get).toHaveBeenCalledTimes(1);
      expect(provider.close).toHaveBeenCalledTimes(1);
    });

    it("rejects revoked caller authority after search and closes the query-bound capability", async () => {
      const { config } = await params.createQueryVault({
        initialize: true,
        config: { search: { backend: "shared", corpus: "memory" } },
      });
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("caller revoked");
        }
      };
      const provider = {
        search: vi.fn().mockImplementation(async () => {
          current = false;
          return { hits: [] };
        }),
        close: vi.fn(),
      };
      params.useNativeProvider();
      params.getActiveMemoryProviderMock.mockResolvedValue({
        provider,
        providerId: "knowledge",
        adapter: "native",
      });
      await expect(
        params.searchMemoryWiki({
          config,
          appConfig: params.createAppConfig(),
          query: "private",
          memoryContext: {
            authority: { kind: "session", sessionKey: "agent:main:main", sandboxed: false },
            assertCurrent,
          },
        }),
      ).rejects.toThrow("caller revoked");
      expect(provider.close).toHaveBeenCalledTimes(1);
      current = true;
      const context = params.getActiveMemoryProviderMock.mock.calls[0]?.[0].context;
      expect(() => context.assertCurrent()).toThrow("query has completed");
    });
  });
}
