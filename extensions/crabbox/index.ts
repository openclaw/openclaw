import { fileURLToPath } from "node:url";
import { definePluginEntry, type OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import {
  CRABBOX_SANDBOX_BACKEND_ID,
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
  resolveCrabboxSandboxWorkdir,
} from "./src/crabbox-sandbox-backend.js";
import { resolveCrabboxSandboxConfig } from "./src/crabbox-sandbox-config.js";
import { mintCrabboxSandboxLeaseId } from "./src/crabbox-sandbox-lease.js";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./src/crabbox-worker-provider.js";
import { resolveCrabboxWarmImagePolicy } from "./src/crabbox-worker-warm-image-policy.js";

const workerWallpaperPath = fileURLToPath(
  new URL("./assets/openclaw-worker-wallpaper.png", import.meta.url),
);

export default definePluginEntry({
  id: "crabbox",
  name: "Crabbox Worker Provider",
  description: "Cloud worker provider and lease-backed sandbox backend for the Crabbox CLI",
  register(api) {
    api.registerCli(
      async ({ program }) => {
        const { registerCrabboxWarmImageCommands } =
          await import("./src/crabbox-worker-warm-image-cli.js");
        registerCrabboxWarmImageCommands(program);
      },
      {
        descriptors: [
          {
            name: "crabbox",
            description: "Inspect and recover Crabbox warm images",
            hasSubcommands: true,
          },
        ],
      },
    );
    api.registerGatewayMethod(
      "crabbox.images.list",
      async (request) => {
        const { listCrabboxImages } = await import("./src/crabbox-gateway-methods.js");
        listCrabboxImages(api, request);
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "crabbox.images.recover",
      async (request) => {
        const { recoverCrabboxImage } = await import("./src/crabbox-gateway-methods.js");
        recoverCrabboxImage(request);
      },
      { scope: "operator.admin" },
    );
    const provider = createCrabboxWorkerProvider({
      openclawRoot: resolveOpenClawRoot(api.rootDir),
      wallpaperPath: workerWallpaperPath,
      warn: (message) => api.logger.warn(message),
      warmImagePolicy: resolveCrabboxWarmImagePolicy(api.pluginConfig),
    });
    for (const action of ["pin", "delete", "rollback"] as const) {
      api.registerGatewayMethod(
        `crabbox.images.${action}`,
        async (request) => {
          const { mutateCrabboxImage } = await import("./src/crabbox-gateway-methods.js");
          await mutateCrabboxImage(api, provider.images, action, request);
        },
        { scope: "operator.admin" },
      );
    }
    api.registerWorkerProvider(provider);
    // Tool-call isolation: the agent loop stays on the Gateway host and only
    // exec/file tools run on a Crabbox-leased box through the ssh backend.
    const sandboxConfig = resolveCrabboxSandboxConfig(api.pluginConfig);
    if (sandboxConfig && api.registrationMode === "full") {
      const backendDependencies = {
        openclawRoot: resolveOpenClawRoot(api.rootDir),
        pluginConfig: sandboxConfig,
      };
      const unregister = registerSandboxBackend(CRABBOX_SANDBOX_BACKEND_ID, {
        factory: createCrabboxSandboxBackendFactory(backendDependencies),
        reserveRuntimeId: mintCrabboxSandboxLeaseId,
        manager: createCrabboxSandboxBackendManager(backendDependencies),
        resolveWorkdir: resolveCrabboxSandboxWorkdir,
      });
      api.lifecycle.registerRuntimeLifecycle({
        id: "crabbox-sandbox-cleanup",
        cleanup: ({ reason, sessionKey, runId }) => {
          if (sessionKey !== undefined || runId !== undefined) {
            return;
          }
          if (reason === "disable" || reason === "restart") {
            unregister();
          }
        },
      });
    }
    // Worker sidecars stop first; plugin services own generation-wide heartbeat cleanup.
    api.registerService({
      id: "crabbox-worker-cleanup",
      start() {},
      stop() {
        return provider.dispose();
      },
    } satisfies OpenClawPluginService);
  },
});
