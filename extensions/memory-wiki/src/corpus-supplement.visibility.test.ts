import fs from "node:fs/promises";
import path from "node:path";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";
import { renderWikiMarkdown } from "./markdown.js";
import { assertToolDetailsRecord, registerMemoryCoreTools } from "./memory-core.test-support.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

const appConfig = {
  // This suite registers memory-core directly; runtime discovery would load unrelated plugins.
  plugins: { enabled: false },
  agents: { entries: { main: {}, secondary: {} } },
} as OpenClawConfig;

async function writeBridgePage(params: {
  rootDir: string;
  slug: string;
  title: string;
  agentIds: string[];
  marker: string;
}): Promise<void> {
  await fs.writeFile(
    path.join(params.rootDir, "sources", `${params.slug}.md`),
    renderWikiMarkdown({
      frontmatter: {
        pageType: "source",
        id: `source.${params.slug}`,
        title: params.title,
        sourceType: "memory-bridge",
        sourcePath: `/tmp/${params.slug}/MEMORY.md`,
        bridgeRelativePath: "MEMORY.md",
        bridgeWorkspaceDir: `/tmp/${params.slug}`,
        bridgeAgentIds: params.agentIds,
      },
      body: `# ${params.title}\n\n${params.marker}\n`,
    }),
    "utf8",
  );
}

describe("memory-wiki corpus supplement visibility", () => {
  it("enforces bridge ownership through direct and registered corpus fallbacks", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      config: { vault: { scope: "global" } },
    });
    await writeBridgePage({
      rootDir,
      slug: "secondary-private",
      title: "Secondary Private",
      agentIds: ["secondary"],
      marker: "REDACTED-FOREIGN-MARKER",
    });
    await writeBridgePage({
      rootDir,
      slug: "main-private",
      title: "Main Private",
      agentIds: ["main"],
      marker: "REDACTED-OWN-MARKER",
    });
    await writeBridgePage({
      rootDir,
      slug: "unowned-private",
      title: "Unowned Private",
      agentIds: [],
      marker: "REDACTED-UNOWNED-MARKER",
    });
    const supplement = createWikiCorpusSupplement({
      getAppConfig: () => appConfig,
      resolveConfig: (agentId, currentAppConfig) =>
        resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
    });
    const caller = {
      agentId: "main",
      agentSessionKey: "agent:main:child-session",
      query: "REDACTED-FOREIGN-MARKER",
    };

    expect(await supplement.search({ ...caller, sandboxed: true })).toEqual([]);
    expect(
      await supplement.get({
        ...caller,
        sandboxed: true,
        lookup: "secondary-private",
      }),
    ).toBeNull();
    expect(
      (await supplement.search({ ...caller, sandboxed: false })).map((result) => result.path),
    ).toEqual(["sources/secondary-private.md"]);
    expect(
      (
        await supplement.get({
          ...caller,
          sandboxed: false,
          lookup: "secondary-private",
        })
      )?.content,
    ).toContain("REDACTED-FOREIGN-MARKER");

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("memory-wiki", supplement);
      const memoryCoreTool = registerMemoryCoreTools(appConfig);
      const sandboxedGet = memoryCoreTool("memory_get", "main", "child-session", true);
      const sandboxedSearch = memoryCoreTool("memory_search", "main", "child-session", true);
      const openGet = memoryCoreTool("memory_get", "main", "child-session", false);
      const openSearch = memoryCoreTool("memory_search", "main", "child-session", false);

      const foreignGet = await sandboxedGet.execute("memory-get-foreign", {
        path: "sources/secondary-private.md",
        corpus: "wiki",
      });
      const unownedGet = await sandboxedGet.execute("memory-get-unowned", {
        path: "sources/unowned-private.md",
        corpus: "wiki",
      });
      const ownGet = await sandboxedGet.execute("memory-get-own", {
        path: "sources/main-private.md",
        corpus: "wiki",
      });
      const foreignSearch = await sandboxedSearch.execute("memory-search-foreign", {
        query: "REDACTED-FOREIGN-MARKER",
        corpus: "wiki",
      });
      const ownSearch = await sandboxedSearch.execute("memory-search-own", {
        query: "REDACTED-OWN-MARKER",
        corpus: "wiki",
      });
      const openForeignGet = await openGet.execute("memory-get-open-foreign", {
        path: "sources/secondary-private.md",
        corpus: "wiki",
      });
      const openForeignSearch = await openSearch.execute("memory-search-open-foreign", {
        query: "REDACTED-FOREIGN-MARKER",
        corpus: "wiki",
      });

      expect(assertToolDetailsRecord(foreignGet.details)).toMatchObject({
        text: "",
        status: "not_found",
        corpora: [{ corpus: "wiki", outcome: "ok" }],
      });
      expect(assertToolDetailsRecord(unownedGet.details)).toMatchObject({
        text: "",
        status: "not_found",
        corpora: [{ corpus: "wiki", outcome: "ok" }],
      });
      expect(assertToolDetailsRecord(ownGet.details)).toMatchObject({
        status: "ok",
        path: "sources/main-private.md",
        text: expect.stringContaining("REDACTED-OWN-MARKER"),
      });
      expect(assertToolDetailsRecord(foreignSearch.details).results).toEqual([]);
      expect(assertToolDetailsRecord(ownSearch.details).results).toEqual([
        expect.objectContaining({ path: "sources/main-private.md" }),
      ]);
      expect(assertToolDetailsRecord(openForeignGet.details)).toMatchObject({
        status: "ok",
        path: "sources/secondary-private.md",
        text: expect.stringContaining("REDACTED-FOREIGN-MARKER"),
      });
      expect(assertToolDetailsRecord(openForeignSearch.details).results).toEqual([
        expect.objectContaining({ path: "sources/secondary-private.md" }),
      ]);
    } finally {
      clearMemoryPluginState();
    }
  }, 240_000);
});
