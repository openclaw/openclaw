import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { claudeMemConfigSchema } from "./config.js";
import { ClaudeMemClient } from "./client.js";

const claudeMemPlugin = {
  id: "memory-claudemem",
  name: "Memory (Claude-Mem)",
  description: "Real-time observation and memory via claude-mem worker",
  kind: "memory" as const,
  configSchema: claudeMemConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = claudeMemConfigSchema.parse(api.pluginConfig);
    const client = new ClaudeMemClient(cfg.workerUrl, cfg.workerTimeout);

    api.logger.info(
      `memory-claudemem: plugin registered (worker: ${cfg.workerUrl})`,
    );

    // TODO: Phase 4 - Hook registration
    // TODO: Phase 5 - Tool registration
    // TODO: Phase 6 - CLI registration
  },
};

export default claudeMemPlugin;
