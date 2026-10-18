import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
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
  useNativeProvider: () => void;
  searchMemoryWiki: typeof searchMemoryWiki;
  getMemoryWikiPage: typeof getMemoryWikiPage;
};

export function registerProviderRecordQueryTests(params: ProviderRecordTestParams): void {
  const { createAppConfig, searchMemoryWiki, getMemoryWikiPage } = params;
  const createInput = async (corpus: "memory" | "all" = "memory") => ({
    ...(await params.createQueryVault({
      initialize: true,
      config: { search: { backend: "shared", corpus } },
    })),
    appConfig: createAppConfig(),
  });
  function useProvider<T extends object>(provider: T): T {
    params.useNativeProvider();
    params.getActiveMemoryProviderMock.mockResolvedValue({
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
    const { rootDir, ...input } = await createInput("all");
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "entity", id: "entity.alpha", title: "Alpha" },
        body: "# Alpha\n\nalpha wiki\n",
      }),
      "utf8",
    );
    if (native) {
      params.useNativeProvider();
    }
    params.getActiveMemorySearchManagerMock.mockRejectedValue(new Error("plugin failed to load"));
    params.getActiveMemoryProviderMock.mockRejectedValue(new Error("plugin failed to load"));

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
      const context = params.getActiveMemoryProviderMock.mock.calls[0]?.[0].context;
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
    expect(params.getActiveMemorySearchManagerMock).not.toHaveBeenCalled();
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
}
