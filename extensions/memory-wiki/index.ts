import { definePluginEntry } from "./api.js";
import { registerWikiCli } from "./src/cli.js";
import {
  hasAnyVaultPathPlaceholder,
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

    // When `vault.path` contains any `{...}` placeholder — a known token
    // like `{workspaceDir}` OR an unknown one like `{tenant}` / a typo like
    // `{workspaceDIR}` — the real vault location is only knowable at
    // wiki-tool invocation time (where `resolveMemoryWikiConfigForCtx` either
    // expands it or throws for unresolved placeholders).
    // `registerMemoryPromptSupplement` and `registerMemoryCorpusSupplement`
    // capture `config` at plugin registration time and their SDK contracts do
    // not thread `workspaceDir`/`agentId`/`agentDir`. Registering them with
    // an unresolved templated path would leave `memory_search`/`memory_get`
    // (wiki corpus) and the memory prompt section reading from the literal
    // templated path while `wiki_search`/`wiki_get` throw at invocation —
    // split-brain failure where `memory_*` flows silently write to a literal
    // brace directory under CWD. Use the broader any-placeholder check so
    // unknown-placeholder configs are also skipped instead of letting
    // `memory_*` fall through to the literal path. When any placeholder is
    // present we skip both surfaces so the `wiki_*` tools remain the single
    // authoritative per-context entry point for the wiki vault.
    const vaultPathIsTemplated = hasAnyVaultPathPlaceholder(config.vault.path);

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
