import { definePluginEntry } from "./api.js";
import { registerWikiCli } from "./src/cli.js";
import {
  containsVaultPathTemplate,
  memoryWikiConfigSchema,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfigForCtx,
} from "./src/config.js";
import { createWikiCorpusSupplement } from "./src/corpus-supplement.js";
import { registerMemoryWikiGatewayMethods } from "./src/gateway.js";
import { createWikiPromptSectionBuilder } from "./src/prompt-section.js";
import {
  createWikiApplyTool,
  createWikiGetTool,
  createWikiLintTool,
  createWikiSearchTool,
  createWikiStatusTool,
} from "./src/tool.js";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki",
  description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
  configSchema: memoryWikiConfigSchema,
  register(api) {
    const config = resolveMemoryWikiConfig(api.pluginConfig);

    // When `vault.path` is templated (e.g. `{workspaceDir}/wiki`) the real
    // vault location is only knowable at wiki-tool invocation time, where the
    // registered factory calls `resolveMemoryWikiConfigForCtx(config, ctx)`.
    // `registerMemoryPromptSupplement` and `registerMemoryCorpusSupplement`
    // capture `config` at plugin registration time and their SDK contracts do
    // not thread `workspaceDir`/`agentId`/`agentDir`, so registering them with
    // an unresolved templated path would leave `memory_search`/`memory_get`
    // (wiki corpus) and the memory prompt section reading from the literal
    // templated path while `wiki_search`/`wiki_get` read from the per-context
    // expanded path — an inconsistency that can return cross-tenant results
    // inside the same conversation. When the operator opts into templating we
    // skip both surfaces so the `wiki_*` tools remain the single authoritative
    // per-context entry point for the wiki vault.
    const vaultPathIsTemplated = containsVaultPathTemplate(config.vault.path);

    if (!vaultPathIsTemplated) {
      api.registerMemoryPromptSupplement(createWikiPromptSectionBuilder(config));
      api.registerMemoryCorpusSupplement(
        createWikiCorpusSupplement({ config, appConfig: api.config }),
      );
    }
    registerMemoryWikiGatewayMethods({ api, config, appConfig: api.config });
    api.registerTool(
      (ctx) => createWikiStatusTool(resolveMemoryWikiConfigForCtx(config, ctx), api.config),
      { name: "wiki_status" },
    );
    api.registerTool(
      (ctx) => createWikiLintTool(resolveMemoryWikiConfigForCtx(config, ctx), api.config),
      { name: "wiki_lint" },
    );
    api.registerTool(
      (ctx) => createWikiApplyTool(resolveMemoryWikiConfigForCtx(config, ctx), api.config),
      { name: "wiki_apply" },
    );
    api.registerTool(
      (ctx) =>
        createWikiSearchTool(resolveMemoryWikiConfigForCtx(config, ctx), api.config, {
          agentId: ctx.agentId,
          agentSessionKey: ctx.sessionKey,
        }),
      { name: "wiki_search" },
    );
    api.registerTool(
      (ctx) =>
        createWikiGetTool(resolveMemoryWikiConfigForCtx(config, ctx), api.config, {
          agentId: ctx.agentId,
          agentSessionKey: ctx.sessionKey,
        }),
      { name: "wiki_get" },
    );
    api.registerCli(
      ({ program }) => {
        registerWikiCli(program, config, api.config);
      },
      {
        descriptors: [
          {
            name: "wiki",
            description: "Inspect and initialize the memory wiki vault",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
