import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createPodmanSandboxBackendFactory,
  createPodmanSandboxBackendManager,
} from "./src/backend.js";
import { createPodmanPluginConfigSchema, resolvePodmanPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "podman",
  name: "Podman Sandbox",
  description: "OpenClaw sandbox backend for rootless Podman containers.",
  configSchema: createPodmanPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolvePodmanPluginConfig(api.pluginConfig);
    registerSandboxBackend("podman", {
      factory: createPodmanSandboxBackendFactory({ pluginConfig }),
      manager: createPodmanSandboxBackendManager({ pluginConfig }),
      resolveWorkdir: ({ cfg }) => cfg.docker.workdir,
    });
  },
});
