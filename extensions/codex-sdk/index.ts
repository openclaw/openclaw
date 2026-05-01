import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import {
  registerCodexCli,
  registerCodexGatewayMethods,
  registerCodexNativeCommand,
} from "./src/commands.js";
import { createCodexSdkPluginConfigSchema } from "./src/config.js";
import { createCodexSdkRuntimeService } from "./src/service.js";

const plugin = {
  id: "codex-sdk",
  name: "Codex SDK Runtime",
  description: "ACP runtime backend powered by the official @openai/codex-sdk package.",
  configSchema: createCodexSdkPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    registerCodexNativeCommand(api);
    registerCodexGatewayMethods(api);
    registerCodexCli(api);
    api.registerService(
      createCodexSdkRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
