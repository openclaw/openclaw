// Memory Wiki plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerWikiCli } from "./src/cli.js";
import { memoryWikiConfigSchema, resolveMemoryWikiConfigForAgent } from "./src/config.js";
import { createWikiCorpusSupplement } from "./src/corpus-supplement.js";
import { registerMemoryWikiGatewayMethods } from "./src/gateway.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
} from "./src/import-runs-state.js";
import { createWikiPromptSectionBuilder } from "./src/prompt-section.js";
import {
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
} from "./src/source-sync-state.js";
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
    const resolveAppConfig = () =>
      (api.runtime.config?.current?.() ?? api.config) as Parameters<
        typeof resolveMemoryWikiConfigForAgent
      >[0];
    const resolveConfig = (
      agentId?: string,
      appConfig: Parameters<typeof resolveMemoryWikiConfigForAgent>[0] = resolveAppConfig(),
    ) => resolveMemoryWikiConfigForAgent(appConfig, agentId);
    const config = resolveConfig();
    configureMemoryWikiSourceSyncStateStore(
      createMemoryWikiSourceSyncStateStore(api.runtime.state.openKeyedStore),
    );
    configureMemoryWikiImportRunStateStore(
      createMemoryWikiImportRunStateStore(api.runtime.state.openKeyedStore),
    );

    api.registerMemoryPromptSupplement(createWikiPromptSectionBuilder(resolveConfig));
    api.registerMemoryCorpusSupplement(
      createWikiCorpusSupplement({ resolveConfig, resolveAppConfig }),
    );
    registerMemoryWikiGatewayMethods({ api, config, resolveConfig, resolveAppConfig });
    api.registerTool(
      (ctx) => createWikiStatusTool(resolveConfig(ctx.agentId), resolveAppConfig()),
      {
        name: "wiki_status",
      },
    );
    api.registerTool((ctx) => createWikiLintTool(resolveConfig(ctx.agentId), resolveAppConfig()), {
      name: "wiki_lint",
    });
    api.registerTool((ctx) => createWikiApplyTool(resolveConfig(ctx.agentId), resolveAppConfig()), {
      name: "wiki_apply",
    });
    api.registerTool(
      (ctx) =>
        createWikiSearchTool(resolveConfig(ctx.agentId), resolveAppConfig(), {
          agentId: ctx.agentId,
          agentSessionKey: ctx.sessionKey,
          sandboxed: ctx.sandboxed,
        }),
      { name: "wiki_search" },
    );
    api.registerTool(
      (ctx) =>
        createWikiGetTool(resolveConfig(ctx.agentId), resolveAppConfig(), {
          agentId: ctx.agentId,
          agentSessionKey: ctx.sessionKey,
          sandboxed: ctx.sandboxed,
        }),
      { name: "wiki_get" },
    );
    api.registerCli(
      ({ program }) => {
        registerWikiCli(program, resolveConfig, resolveAppConfig);
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
