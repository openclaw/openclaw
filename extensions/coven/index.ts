import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCovenPluginConfigSchema, resolveCovenPluginConfig } from "./src/config.js";
import { CovenAcpRuntime, COVEN_BACKEND_ID } from "./src/runtime.js";

export default definePluginEntry({
  id: COVEN_BACKEND_ID,
  name: "Coven ACP Runtime",
  description:
    "Opt-in ACP runtime backend that launches coding tasks through a local Coven daemon.",
  configSchema: () => createCovenPluginConfigSchema(),
  register(api) {
    api.registerService({
      id: "coven-runtime",
      async start(ctx) {
        const config = resolveCovenPluginConfig({
          rawConfig: api.pluginConfig,
          workspaceDir: ctx.workspaceDir,
        });
        const runtime = new CovenAcpRuntime({ config, logger: ctx.logger });
        registerAcpRuntimeBackend({ id: COVEN_BACKEND_ID, runtime });
        ctx.logger.info(`coven ACP runtime backend registered (socket: ${config.socketPath})`);
      },
      async stop() {
        unregisterAcpRuntimeBackend(COVEN_BACKEND_ID);
      },
    });
  },
});
