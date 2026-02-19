import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryWriteTool = api.runtime.tools.createMemoryWriteTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryUpsertTool = api.runtime.tools.createMemoryUpsertTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const tools = [memorySearchTool, memoryGetTool, memoryWriteTool, memoryUpsertTool].filter(
          (tool): tool is NonNullable<typeof tool> => Boolean(tool),
        );
        return tools.length > 0 ? tools : null;
      },
      { names: ["memory_search", "memory_get", "memory_write", "memory_upsert"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
