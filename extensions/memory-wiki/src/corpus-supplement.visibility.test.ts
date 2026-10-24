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

async function writeBridgePage(
  rootDir: string,
  slug: string,
  title: string,
  agentIds: readonly string[],
  marker: string,
): Promise<void> {
  await fs.writeFile(
    path.join(rootDir, "sources", `${slug}.md`),
    renderWikiMarkdown({
      frontmatter: {
        pageType: "source",
        id: `source.${slug}`,
        title,
        sourceType: "memory-bridge",
        sourcePath: `/tmp/${slug}/MEMORY.md`,
        bridgeRelativePath: "MEMORY.md",
        bridgeWorkspaceDir: `/tmp/${slug}`,
        bridgeAgentIds: agentIds,
      },
      body: `# ${title}\n\n${marker}\n`,
    }),
    "utf8",
  );
}

describe("memory-wiki corpus supplement visibility", () => {
  it("enforces bridge ownership through registered corpus fallbacks", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      config: { vault: { scope: "global" } },
    });
    for (const [slug, title, agentIds, marker] of [
      ["secondary-private", "Secondary Private", ["secondary"], "REDACTED-FOREIGN-MARKER"],
      ["main-private", "Main Private", ["main"], "REDACTED-OWN-MARKER"],
      ["unowned-private", "Unowned Private", [], "REDACTED-UNOWNED-MARKER"],
    ] as const) {
      await writeBridgePage(rootDir, slug, title, agentIds, marker);
    }
    const supplement = createWikiCorpusSupplement({
      getAppConfig: () => appConfig,
      resolveConfig: (agentId, currentAppConfig) =>
        resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
    });
    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("memory-wiki", supplement);
      const memoryCoreTool = registerMemoryCoreTools(appConfig);
      const sandboxedGet = memoryCoreTool("memory_get", "main", "child-session", true);
      const sandboxedSearch = memoryCoreTool("memory_search", "main", "child-session", true);
      const openGet = memoryCoreTool("memory_get", "main", "child-session", false);
      const openSearch = memoryCoreTool("memory_search", "main", "child-session", false);
      async function get(slug: string, sandboxed = true) {
        const tool = sandboxed ? sandboxedGet : openGet;
        const result = await tool.execute(`get-${slug}`, {
          path: `sources/${slug}-private.md`,
          corpus: "wiki",
        });
        return assertToolDetailsRecord(result.details);
      }
      async function search(marker: string, sandboxed = true) {
        const tool = sandboxed ? sandboxedSearch : openSearch;
        const result = await tool.execute(`search-${marker}`, { query: marker, corpus: "wiki" });
        return assertToolDetailsRecord(result.details).results;
      }
      for (const slug of ["secondary", "unowned"]) {
        expect(await get(slug)).toMatchObject({
          text: "",
          status: "not_found",
          corpora: [{ corpus: "wiki", outcome: "ok" }],
        });
      }
      expect(await get("main")).toMatchObject({
        status: "ok",
        path: "sources/main-private.md",
        text: expect.stringContaining("REDACTED-OWN-MARKER"),
      });
      expect(await search("REDACTED-FOREIGN-MARKER")).toEqual([]);
      expect(await search("REDACTED-OWN-MARKER")).toEqual([
        expect.objectContaining({ path: "sources/main-private.md" }),
      ]);
      expect(await get("secondary", false)).toMatchObject({
        status: "ok",
        path: "sources/secondary-private.md",
        text: expect.stringContaining("REDACTED-FOREIGN-MARKER"),
      });
      expect(await search("REDACTED-FOREIGN-MARKER", false)).toEqual([
        expect.objectContaining({ path: "sources/secondary-private.md" }),
      ]);
    } finally {
      clearMemoryPluginState();
    }
  }, 240_000);
});
