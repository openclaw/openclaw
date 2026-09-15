// SRT sandbox plugin entrypoint.
//
// Registers a local, Docker-free sandbox backend built on the Anthropic Sandbox
// Runtime (SRT). S1 wires the plugin skeleton: config schema, backend
// registration via registerSandboxBackend(), and runtime-lifecycle-scoped
// unregistration. The backend itself (macOS Seatbelt exec path) lives in
// ./src/backend.ts.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  resolveSrtSandboxWorkdir,
  SRT_SANDBOX_BACKEND_ID,
} from "./src/backend.js";
import { createSrtPluginConfigSchema, resolveSrtPluginConfig } from "./src/config.js";

export default definePluginEntry({
  id: "srt-sandbox",
  name: "SRT Sandbox",
  description:
    "Docker-free local sandbox backend built on the Anthropic Sandbox Runtime (macOS Seatbelt).",
  configSchema: createSrtPluginConfigSchema(),
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const pluginConfig = resolveSrtPluginConfig(api.pluginConfig);
    const unregister = registerSandboxBackend(SRT_SANDBOX_BACKEND_ID, {
      factory: createSrtSandboxBackendFactory({ pluginConfig }),
      manager: createSrtSandboxBackendManager(),
      resolveWorkdir: resolveSrtSandboxWorkdir,
    });
    // Eager registrations must retire even if Gateway services never start.
    api.lifecycle.registerRuntimeLifecycle({
      id: "srt-sandbox-cleanup",
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
