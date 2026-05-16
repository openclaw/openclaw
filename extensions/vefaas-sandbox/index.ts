import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createVefaasSandboxBackendFactory,
  createVefaasSandboxBackendManager,
} from "./src/backend.js";
import { createVefaasOpencodeAcpService } from "./src/acp-service.js";
import { createVefaasPluginConfigSchema, resolveVefaasPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "vefaas-sandbox",
  name: "VEFaaS Sandbox",
  description: "VEFaaS-backed remote sandbox runtime for agent exec and file tools.",
  configSchema: createVefaasPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveVefaasPluginConfig(api.pluginConfig);
    registerSandboxBackend("vefaas", {
      factory: createVefaasSandboxBackendFactory({
        pluginConfig,
      }),
      manager: createVefaasSandboxBackendManager({
        pluginConfig,
      }),
    });
    api.registerService(
      createVefaasOpencodeAcpService({
        pluginConfig,
      }),
    );
  },
});
