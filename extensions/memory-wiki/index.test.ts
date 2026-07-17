// Memory Wiki tests cover index plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./api.js";
import plugin from "./index.js";
import { loadMemoryWikiVaultGeneration } from "./src/log.js";
import { createMemoryWikiTestHarness } from "./src/test-helpers.js";

const toolMocks = vi.hoisted(() => {
  const createTool = (name: string) =>
    vi.fn((config: unknown, _appConfig?: unknown, memoryContext?: unknown) => ({
      name,
      testConfig: config,
      testMemoryContext: memoryContext,
    }));
  return {
    createWikiApplyTool: createTool("wiki_apply"),
    createWikiGetTool: createTool("wiki_get"),
    createWikiLintTool: createTool("wiki_lint"),
    createWikiSearchTool: createTool("wiki_search"),
    createWikiStatusTool: createTool("wiki_status"),
  };
});

vi.mock("./src/tool.js", () => toolMocks);

const { createPluginApi, createTempDir } = createMemoryWikiTestHarness();

describe("memory-wiki plugin", () => {
  it("registers prompt supplement, gateway methods, tools, and wiki cli surface", () => {
    const {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptPreparation,
      registerMemoryPromptSupplement,
      registerService,
      registerTool,
    } = createPluginApi();

    plugin.register(api);

    expect(registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptPreparation).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptSupplement).toHaveBeenCalledTimes(1);
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "memory-wiki-compiled-cache-owner-cleanup" }),
    );
    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "wiki.status",
      "wiki.importRuns",
      "wiki.importInsights",
      "wiki.palace",
      "wiki.init",
      "wiki.doctor",
      "wiki.compile",
      "wiki.ingest",
      "wiki.lint",
      "wiki.bridge.import",
      "wiki.unsafeLocal.import",
      "wiki.search",
      "wiki.apply",
      "wiki.get",
      "wiki.obsidian.status",
      "wiki.obsidian.search",
      "wiki.obsidian.open",
      "wiki.obsidian.command",
      "wiki.obsidian.daily",
    ]);
    expect(registerTool).toHaveBeenCalledTimes(5);
    expect(registerTool.mock.calls.map((call) => call[1]?.name)).toEqual([
      "wiki_status",
      "wiki_lint",
      "wiki_apply",
      "wiki_search",
      "wiki_get",
    ]);
    expect(registerTool.mock.calls.map((call) => typeof call[0])).toEqual([
      "function",
      "function",
      "function",
      "function",
      "function",
    ]);
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toStrictEqual({
      descriptors: [
        {
          name: "wiki",
          description: "Inspect and initialize the memory wiki vault",
          hasSubcommands: true,
        },
      ],
    });
  });

  it("resolves every tool factory from the invocation agent", async () => {
    const rootDir = await createTempDir("memory-wiki-index-agents-");
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    } as OpenClawConfig;
    const { api, registerTool } = createPluginApi();
    api.config = appConfig;
    api.pluginConfig = {
      vault: { scope: "agent", path: rootDir },
    };
    Object.assign(api.runtime, {
      config: {
        current: () => appConfig,
      },
    });

    plugin.register(api);

    for (const [factory, registration] of registerTool.mock.calls) {
      expect(factory).toEqual(expect.any(Function));
      expect(factory({})).toBeNull();
      const supportTool = factory({ agentId: "support" });
      const marketingTool = factory({ agentId: "marketing" });
      expect(supportTool).toMatchObject({
        name: registration.name,
        testConfig: {
          agentId: "support",
          vault: { scope: "agent", path: path.join(rootDir, "support") },
        },
      });
      expect(marketingTool).toMatchObject({
        name: registration.name,
        testConfig: {
          agentId: "marketing",
          vault: { scope: "agent", path: path.join(rootDir, "marketing") },
        },
      });
      if (registration.name === "wiki_status") {
        expect(supportTool).toMatchObject({ testMemoryContext: { agentId: "support" } });
        expect(marketingTool).toMatchObject({ testMemoryContext: { agentId: "marketing" } });
      }
      expect(() => factory({ agentId: "finance" })).toThrow("Unknown memory-wiki agentId: finance");
    }
  });

  it("activates an initialized legacy vault before an external compile", async () => {
    const rootDir = await createTempDir("memory-wiki-index-legacy-vault-");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki"), { recursive: true });
    await fs.writeFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "", "utf8");
    const { api, registerService } = createPluginApi();
    api.pluginConfig = { vault: { path: rootDir } };

    plugin.register(api);
    const service = registerService.mock.calls[0]?.[0];
    await service?.start?.();

    await expect(loadMemoryWikiVaultGeneration(rootDir)).resolves.toEqual(expect.any(String));
  });
});
