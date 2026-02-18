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
        const memoryRecallTool = api.runtime.tools.createMemoryRecallTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [
          memorySearchTool,
          memoryGetTool,
          ...(memoryWriteTool ? [memoryWriteTool] : []),
          ...(memoryRecallTool ? [memoryRecallTool] : []),
        ];
      },
      { names: ["memory_search", "memory_get", "memory_write", "memory_recall"] },
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
