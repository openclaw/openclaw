// Memory Wiki tests cover agent-scoped vault isolation through the public tools.
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";
import { assertToolDetailsRecord, registerMemoryCoreTools } from "./memory-core.test-support.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiGetTool, createWikiSearchTool } from "./tool.js";

const { createTempDir } = createMemoryWikiTestHarness();

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

describe("agent-scoped memory-wiki tools", () => {
  it("keeps apply, search, and get behavior isolated by configured agent", async () => {
    const vaultParent = await createTempDir("memory-wiki-agent-vaults-");
    const appConfig = {
      // This suite registers memory-core directly; runtime discovery would load unrelated plugins.
      plugins: { enabled: false },
      agents: {
        entries: { support: {}, marketing: {} },
      },
    } as OpenClawConfig;
    const baseConfig = resolveMemoryWikiConfig({
      vault: { scope: "agent", path: vaultParent },
      search: { backend: "local", corpus: "wiki" },
    });

    async function createAgent(id: string, title: string, sentinel: string) {
      const config = resolveMemoryWikiAgentConfig({ config: baseConfig, appConfig, agentId: id });
      const result = await createWikiApplyTool(config, appConfig).execute(`apply-${id}`, {
        op: "create_synthesis",
        title,
        body: `Private synthesis marker: ${sentinel}`,
        sourceIds: [`source.${id}`],
      });
      const pagePath = assertToolDetailsRecord(result.details).pagePath;
      if (typeof pagePath !== "string") {
        throw new Error("Expected wiki_apply to return pagePath");
      }
      return { id, sentinel, config, pagePath };
    }
    const support = await createAgent(
      "support",
      "Support Private Synthesis",
      "SUPPORT_ONLY_7f3c21",
    );
    const marketing = await createAgent(
      "marketing",
      "Marketing Private Synthesis",
      "MARKETING_ONLY_8e4d62",
    );
    const pairs = [
      [support, marketing],
      [marketing, support],
    ] as const;

    expect(support.config.vault.path).toBe(path.join(vaultParent, "support"));
    expect(marketing.config.vault.path).toBe(path.join(vaultParent, "marketing"));
    expect(support.config.vault.path).not.toBe(marketing.config.vault.path);

    for (const [agent, foreignAgent] of pairs) {
      expect((await fs.stat(agent.config.vault.path)).isDirectory()).toBe(true);
      await expect(
        fs.readFile(path.join(agent.config.vault.path, agent.pagePath), "utf8"),
      ).resolves.toContain(agent.sentinel);
      await expect(
        fs.access(path.join(agent.config.vault.path, foreignAgent.pagePath)),
      ).rejects.toThrow();

      const searchTool = createWikiSearchTool(agent.config, appConfig, {
        agentId: agent.id,
      });
      const ownSearch = await searchTool.execute(`search-own-${agent.id}`, {
        query: agent.sentinel,
      });
      expect(textContent(ownSearch)).toContain(agent.sentinel);
      expect(assertToolDetailsRecord(ownSearch.details).results).toEqual([
        expect.objectContaining({ path: agent.pagePath }),
      ]);

      const foreignSearch = await searchTool.execute(`search-foreign-${agent.id}`, {
        query: foreignAgent.sentinel,
      });
      expect(textContent(foreignSearch)).toBe("No wiki or memory results.");
      expect(assertToolDetailsRecord(foreignSearch.details).results).toEqual([]);

      const getTool = createWikiGetTool(agent.config, appConfig, { agentId: agent.id });
      const ownGet = await getTool.execute(`get-own-${agent.id}`, { lookup: agent.pagePath });
      expect(textContent(ownGet)).toContain(agent.sentinel);
      expect(assertToolDetailsRecord(ownGet.details).found).toBe(true);

      const foreignGet = await getTool.execute(`get-foreign-${agent.id}`, {
        lookup: foreignAgent.pagePath,
      });
      expect(textContent(foreignGet)).toBe(`Wiki page not found: ${foreignAgent.pagePath}`);
      expect(assertToolDetailsRecord(foreignGet.details).found).toBe(false);
    }

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement(
        "memory-wiki",
        createWikiCorpusSupplement({
          resolveConfig: (agentId, currentAppConfig) =>
            resolveMemoryWikiAgentConfig({
              config: baseConfig,
              appConfig: currentAppConfig,
              agentId,
            }),
          getAppConfig: () => appConfig,
        }),
      );
      const memoryCoreTool = registerMemoryCoreTools(appConfig);

      for (const [agent, foreignAgent] of pairs) {
        const memorySearch = memoryCoreTool("memory_search", agent.id, "main");
        const memoryGet = memoryCoreTool("memory_get", agent.id, "main");
        async function search(sentinel: string) {
          const result = await memorySearch.execute(`search-${sentinel}`, {
            query: sentinel,
            corpus: "wiki",
          });
          return assertToolDetailsRecord(result.details).results;
        }
        async function get(pagePath: string) {
          const result = await memoryGet.execute(`get-${pagePath}`, {
            path: pagePath,
            corpus: "wiki",
          });
          return assertToolDetailsRecord(result.details);
        }
        expect(await search(agent.sentinel)).toEqual([
          expect.objectContaining({
            corpus: "wiki",
            path: agent.pagePath,
            snippet: expect.stringContaining(agent.sentinel),
          }),
        ]);

        expect(await search(foreignAgent.sentinel)).toEqual([]);
        expect(await get(agent.pagePath)).toMatchObject({
          status: "ok",
          corpus: "wiki",
          path: agent.pagePath,
          text: expect.stringContaining(agent.sentinel),
        });

        expect(await get(foreignAgent.pagePath)).toMatchObject({
          path: foreignAgent.pagePath,
          text: "",
          status: "not_found",
          corpora: [{ corpus: "wiki", outcome: "ok" }],
        });
      }
    } finally {
      clearMemoryPluginState();
    }
  }, 360_000);
});
