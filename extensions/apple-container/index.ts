import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createAppleContainerSandboxBackendFactory,
  createAppleContainerSandboxBackendManager,
} from "./src/backend.js";
import {
  createAppleContainerPluginConfigSchema,
  resolveAppleContainerPluginConfig,
} from "./src/config.js";

const plugin = {
  id: "apple-container",
  name: "Apple Container Sandbox",
  description: "Apple container-backed sandbox runtime for agent exec and file tools.",
  configSchema: createAppleContainerPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveAppleContainerPluginConfig(api.pluginConfig);
    registerSandboxBackend("apple-container", {
      factory: createAppleContainerSandboxBackendFactory({ pluginConfig }),
      manager: createAppleContainerSandboxBackendManager({ pluginConfig }),
    });
  },
};

export default plugin;
