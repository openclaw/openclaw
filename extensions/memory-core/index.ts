import { appendFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/memory-core";

function traceMemoryCoreStage(stage: string): void {
  const stageLogPath = process.env.OPENCLAW_STAGE_LOG?.trim();
  if (!stageLogPath) {
    return;
  }
  try {
    appendFileSync(stageLogPath, `${new Date().toISOString()} ${stage}\n`);
  } catch {
    // Best-effort tracing only.
  }
}

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        traceMemoryCoreStage("memory-core-factory-pre-search-tool");
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        traceMemoryCoreStage(
          `memory-core-factory-post-search-tool ready=${memorySearchTool ? "yes" : "no"}`,
        );
        traceMemoryCoreStage("memory-core-factory-pre-get-tool");
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        traceMemoryCoreStage(
          `memory-core-factory-post-get-tool ready=${memoryGetTool ? "yes" : "no"}`,
        );
        if (!memorySearchTool || !memoryGetTool) {
          traceMemoryCoreStage("memory-core-factory-return-null");
          return null;
        }
        traceMemoryCoreStage("memory-core-factory-return-tools");
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
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
