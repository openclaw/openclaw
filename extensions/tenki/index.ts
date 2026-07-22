// Tenki plugin entrypoint registers the Tenki Cloud sandbox backend.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createTenkiSandboxBackendFactory,
  createTenkiSandboxBackendManager,
  resolveTenkiRuntimePaths,
} from "./src/backend.js";
import { createTenkiPluginConfigSchema, resolveTenkiPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "tenki",
  name: "Tenki Cloud Sandbox",
  description: "Tenki Cloud microVM-backed sandbox runtime for agent exec and file tools.",
  configSchema: createTenkiPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveTenkiPluginConfig(api.pluginConfig);
    registerSandboxBackend("tenki", {
      factory: createTenkiSandboxBackendFactory({ pluginConfig }),
      manager: createTenkiSandboxBackendManager({ pluginConfig }),
      resolveWorkdir: ({ scopeKey }) =>
        resolveTenkiRuntimePaths(pluginConfig.workspaceRoot, scopeKey).remoteWorkspaceDir,
    });
  },
});
