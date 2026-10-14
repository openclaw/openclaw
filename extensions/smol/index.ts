import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createSmolSandboxBackendFactory,
  createSmolSandboxBackendManager,
  resolveSmolSandboxWorkdir,
} from "./src/backend.js";
import { createSmolPluginConfigSchema, resolveSmolPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "smol",
  name: "smol machines Sandbox",
  description:
    "Run each sandbox as a smol machine: a real Linux microVM on this host with the workspace mounted like the Docker backend, no container runtime required.",
  configSchema: createSmolPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveSmolPluginConfig(api.pluginConfig);
    const unregister = registerSandboxBackend("smol", {
      factory: createSmolSandboxBackendFactory({ pluginConfig }),
      manager: createSmolSandboxBackendManager({ pluginConfig }),
      resolveWorkdir: (params) => resolveSmolSandboxWorkdir(pluginConfig, params),
      capabilities: { readOnlyResourceMounts: true },
    });
    // Eager CLI registrations must retire even if Gateway services never start.
    api.lifecycle.registerRuntimeLifecycle({
      id: "smol-sandbox-cleanup",
      cleanup: ({ reason, sessionKey, runId }) => {
        if (sessionKey !== undefined || runId !== undefined) {
          return;
        }
        if (reason === "disable" || reason === "restart") {
          unregister();
        }
      },
    });
  },
});
