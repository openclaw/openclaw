import nodePath from "node:path";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";
import { assertToolDetailsRecord, registerMemoryCoreTools } from "./memory-core.test-support.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiGetTool, createWikiSearchTool } from "./tool.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
afterEach(() => clearMemoryPluginState());

async function invoke(tool: ReturnType<typeof createWikiGetTool>, args: unknown) {
  const result = await tool.execute("isolation", args);
  return {
    text: result.content.find((part) => part.type === "text")?.text ?? "",
    details: assertToolDetailsRecord(result.details),
  };
}

it("isolates agent vaults through wiki tools and registered memory-core fallbacks", async () => {
  const appConfig: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { entries: { "support-team": {}, marketing: {} } },
  };
  const baseConfig = resolveMemoryWikiConfig({
    vault: { scope: "agent", path: await createTempDir("memory-wiki-agent-vaults-") },
    search: { backend: "local", corpus: "wiki" },
  });
  async function createAgent(requestedId: string, id: string) {
    const config = resolveMemoryWikiAgentConfig({
      config: baseConfig,
      appConfig,
      agentId: requestedId,
    });
    expect(config).toMatchObject({
      agentId: id,
      vault: { scope: "agent", path: nodePath.join(baseConfig.vault.path, id) },
    });
    const sentinel = `${id.toUpperCase()}_ONLY_7f3c21`;
    const { details } = await invoke(createWikiApplyTool(config, appConfig), {
      op: "create_synthesis",
      title: `${id} Private Synthesis`,
      body: `Private synthesis marker: ${sentinel}`,
      sourceIds: [`source.${id}`],
    });
    if (typeof details.pagePath !== "string") {
      throw new Error("Expected wiki_apply to return pagePath");
    }
    return { id, config, sentinel, pagePath: details.pagePath };
  }
  const agents = [
    await createAgent(" SUPPORT TEAM ", "support-team"),
    await createAgent("MARKETING", "marketing"),
  ];
  clearMemoryPluginState();
  const memoryCoreTool = registerCorpus(baseConfig, appConfig);
  for (const agent of agents) {
    const context = { agentId: agent.id };
    const search = createWikiSearchTool(agent.config, appConfig, context);
    const get = createWikiGetTool(agent.config, appConfig, context);
    const memorySearch = memoryCoreTool("memory_search", agent.id, "main");
    const memoryGet = memoryCoreTool("memory_get", agent.id, "main");
    for (const target of agents) {
      const own = target === agent;
      const result = await invoke(search, { query: target.sentinel });
      expect(result.text).toEqual(
        own ? expect.stringContaining(target.sentinel) : "No wiki or memory results.",
      );
      expect(result.details.results).toEqual(
        own ? [expect.objectContaining({ path: target.pagePath })] : [],
      );
      const page = await invoke(get, { lookup: target.pagePath });
      expect(page.text).toEqual(
        own ? expect.stringContaining(target.sentinel) : `Wiki page not found: ${target.pagePath}`,
      );
      expect(page.details.found).toBe(own);

      const hits = await invoke(memorySearch, { query: target.sentinel, corpus: "wiki" });
      expect(hits.details.results).toEqual(
        own
          ? [
              expect.objectContaining({
                corpus: "wiki",
                path: target.pagePath,
                snippet: expect.stringContaining(target.sentinel),
              }),
            ]
          : [],
      );
      const read = await invoke(memoryGet, { path: target.pagePath, corpus: "wiki" });
      expect(read.details).toMatchObject(
        own
          ? {
              status: "ok",
              corpus: "wiki",
              path: target.pagePath,
              text: expect.stringContaining(target.sentinel),
            }
          : {
              path: target.pagePath,
              text: "",
              status: "not_found",
              corpora: [{ corpus: "wiki", outcome: "ok" }],
            },
      );
    }
  }
}, 360_000);

function registerCorpus(
  config: ReturnType<typeof resolveMemoryWikiConfig>,
  appConfig: OpenClawConfig,
) {
  registerMemoryCorpusSupplement(
    "memory-wiki",
    createWikiCorpusSupplement({
      resolveConfig: (agentId, currentAppConfig) =>
        resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
      getAppConfig: () => appConfig,
    }),
  );
  return registerMemoryCoreTools(appConfig);
}

it("enforces bridge ownership through registered corpus fallbacks", async () => {
  const appConfig: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { entries: { main: {}, secondary: {} } },
  };
  const { config, page } = await createVault({
    initialize: true,
    config: { vault: { scope: "global" } },
  });
  for (const owner of ["main", "secondary", "unowned"]) {
    await page(
      `sources/${owner}.md`,
      {
        title: owner,
        pageType: "source",
        sourceType: "memory-bridge",
        bridgeAgentIds: owner === "unowned" ? [] : [owner],
      },
      `PRIVATE_${owner}_MARKER`,
    );
  }
  clearMemoryPluginState();
  const tools = registerCorpus(config, appConfig);
  for (const [sandboxed, owner, allowed] of [
    [true, "secondary", false],
    [true, "unowned", false],
    [true, "main", true],
    [false, "secondary", true],
  ] as const) {
    const path = `sources/${owner}.md`;
    const marker = `PRIVATE_${owner}_MARKER`;
    const get = await invoke(tools("memory_get", "main", "child-session", sandboxed), {
      path,
      corpus: "wiki",
    });
    expect(get.details).toMatchObject(
      allowed
        ? { status: "ok", path, text: expect.stringContaining(marker) }
        : { text: "", status: "not_found", corpora: [{ corpus: "wiki", outcome: "ok" }] },
    );
    const search = await invoke(tools("memory_search", "main", "child-session", sandboxed), {
      query: marker,
      corpus: "wiki",
    });
    expect(search.details.results).toEqual(allowed ? [expect.objectContaining({ path })] : []);
  }
}, 240_000);
