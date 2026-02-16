import type { PluginRuntime } from "smart-agent-neo/plugin-sdk";
import os from "node:os";
import path from "node:path";

export const msteamsRuntimeStub = {
  state: {
    resolveStateDir: (env: NodeJS.ProcessEnv = process.env, homedir?: () => string) => {
      const override = env.SMART_AGENT_NEO_STATE_DIR?.trim() || env.SMART_AGENT_NEO_STATE_DIR?.trim();
      if (override) {
        return override;
      }
      const resolvedHome = homedir ? homedir() : os.homedir();
      return path.join(resolvedHome, ".smart-agent-neo");
    },
  },
} as unknown as PluginRuntime;
