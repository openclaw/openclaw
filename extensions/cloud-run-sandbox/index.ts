import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { BACKEND_ID, createBackend, createManager, reserveRuntimeId } from "./src/backend.js";
import { configSchema, resolveConfig } from "./src/config.js";
import { GuestOwner, type GuestRecord } from "./src/guest.js";

export default definePluginEntry({
  id: BACKEND_ID,
  name: "Cloud Run Sandbox (experimental)",
  description: "Isolated per-command Cloud Run guests. Not a Gateway hosting/storage backend.",
  configSchema,
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const config = resolveConfig(api.pluginConfig);
    const createOwner = () =>
      new GuestOwner(
        api.runtime.state.openKeyedStore<GuestRecord>({
          namespace: "guest-cleanup",
          maxEntries: 10000,
          overflowPolicy: "reject-new",
        }),
      );
    let owner = createOwner();
    let stopped = false;
    const stop = async () => {
      stopped = true;
      await owner.stop();
    };
    const stateDir = api.runtime.state.resolveStateDir();
    const unregister = registerSandboxBackend(BACKEND_ID, {
      factory: (params) => createBackend(params, config, owner, stateDir),
      reserveRuntimeId,
      manager: {
        describeRuntime: (params) => createManager(owner, config).describeRuntime(params),
        removeRuntime: (params) => createManager(owner, config).removeRuntime(params),
      },
      resolveWorkdir: () => "/workspace",
      capabilities: { readOnlyResourceMounts: true },
    });
    api.lifecycle.registerRuntimeLifecycle({
      id: "cloud-run-sandbox-cleanup",
      async cleanup({ reason, sessionKey, runId }) {
        if (sessionKey !== undefined || runId !== undefined) {
          return;
        }
        if (reason === "disable" || reason === "restart") {
          unregister();
          await stop();
        }
      },
    });
    api.registerService({
      id: "cloud-run-sandbox-guests",
      async start() {
        if (stopped) {
          owner = createOwner();
          stopped = false;
        }
        await owner.recover();
      },
      stop,
    });
  },
});
