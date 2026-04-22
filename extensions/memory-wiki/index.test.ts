import { describe, expect, it } from "vitest";
import type { AnyAgentTool, OpenClawPluginToolContext } from "./api.js";
import plugin from "./index.js";
import { createMemoryWikiTestHarness } from "./src/test-helpers.js";

const { createPluginApi } = createMemoryWikiTestHarness();

describe("memory-wiki plugin", () => {
  it("registers prompt supplement, gateway methods, tools, and wiki cli surface", async () => {
    const {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptSupplement,
      registerTool,
    } = createPluginApi();

    await plugin.register(api);

    expect(registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptSupplement).toHaveBeenCalledTimes(1);
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
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      descriptors: [
        expect.objectContaining({
          name: "wiki",
          hasSubcommands: true,
        }),
      ],
    });
  });

  it("skips memory prompt and corpus supplements when vault.path is templated", async () => {
    const {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptSupplement,
      registerTool,
    } = createPluginApi({
      pluginConfig: { vault: { path: "{workspaceDir}/wiki" } },
    });

    await plugin.register(api);

    // Templated vault paths can only be resolved at wiki-tool invocation time.
    // The memory-corpus supplement and prompt-section builder would otherwise
    // keep reading the unexpanded literal path while `wiki_search`/`wiki_get`
    // run against the per-context expansion, producing cross-tenant results
    // for the same conversation. Skip registration to enforce a single
    // per-context entry point via the `wiki_*` tools.
    expect(registerMemoryCorpusSupplement).not.toHaveBeenCalled();
    expect(registerMemoryPromptSupplement).not.toHaveBeenCalled();

    // The rest of the surface is unchanged — tools, gateway methods, and CLI
    // still register so operators can use the per-context `wiki_*` path and
    // keep operator-facing gateway/CLI surfaces for administration.
    expect(registerTool).toHaveBeenCalledTimes(5);
    expect(registerGatewayMethod).toHaveBeenCalled();
    expect(registerCli).toHaveBeenCalledTimes(1);
  });

  it("keeps wiki_* tools visible in the catalog when vault.path is templated and factory context is partial, failing loud at execute time", async () => {
    // Regression: `src/plugins/tools.ts` (`resolvePluginTools`) wraps each
    // factory call in try/catch and silently skips the tool on throw. Before
    // the guard, `resolveMemoryWikiConfigForCtx` throwing on unresolved
    // placeholders (e.g. `plugin-tools-serve.ts` passing `{ config }` only)
    // made every `wiki_*` tool disappear from the MCP catalog with no
    // actionable signal to the caller. The factory must return a stub tool
    // that surfaces the original error at invocation time instead.
    const { api, registerTool } = createPluginApi({
      pluginConfig: { vault: { path: "{workspaceDir}/wiki" } },
    });

    await plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(5);

    const partialCtx = { config: api.config } as OpenClawPluginToolContext;

    for (const call of registerTool.mock.calls) {
      const factory = call[0] as (ctx: OpenClawPluginToolContext) => AnyAgentTool;
      const tool = factory(partialCtx);
      expect(tool).toBeTruthy();
      // Stub preserves the original tool name so callers (MCP clients,
      // gateway catalog, agents) still see the tool exists.
      expect(tool.name).toMatch(/^wiki_/);
      // Invoking surfaces the placeholder-expansion error from
      // `expandVaultPathTemplate` rather than swallowing it.
      await expect(
        (tool as { execute: (id: string, args: unknown) => Promise<unknown> }).execute("call", {}),
      ).rejects.toThrow(/unresolved placeholder\(s\) \{workspaceDir\}/);
    }
  });

  it("also skips memory supplements when vault.path contains only unknown placeholders", async () => {
    // Regression: the previous gate used the narrow known-tokens regex, so a
    // config like `{tenant}/wiki` (or a typo like `{workspaceDIR}/wiki`)
    // registered the memory supplements against the literal brace path. At
    // tool invocation `wiki_*` would throw on expansion while `memory_*`
    // flows would silently write/read through `fs.mkdir`/`initializeMemoryWikiVault`
    // against a CWD-relative `./{tenant}/wiki` — asymmetric fail-closed with
    // cross-surface data mixing.
    const { api, registerMemoryCorpusSupplement, registerMemoryPromptSupplement } = createPluginApi(
      {
        pluginConfig: { vault: { path: "{tenant}/wiki" } },
      },
    );

    await plugin.register(api);

    expect(registerMemoryCorpusSupplement).not.toHaveBeenCalled();
    expect(registerMemoryPromptSupplement).not.toHaveBeenCalled();
  });
});
