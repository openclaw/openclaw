import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { buildMxcNativeEnv, resolveMxcNativeBinaries } from "./binary-resolver.js";
import { resolveConfig } from "./config.js";
import { createMxcSandboxBackendFactory } from "./mxc-backend-factory.js";
import { mxcSandboxBackendManager } from "./mxc-backend.js";
import { assertMxcReadiness, warnMxcHostPrepIfNeeded } from "./readiness.js";

export function registerMxcPlugin(api: OpenClawPluginApi): void {
  if (api.registrationMode !== "full") {
    return;
  }

  const config = resolveConfig(api.pluginConfig);

  if (process.platform !== "win32") {
    console.warn(
      `[mxc] Sandbox backend is Windows-only and not available on ${process.platform}. Plugin will be dormant.`,
    );
    return;
  }

  let nativeEnv: Record<string, string>;
  try {
    nativeEnv = buildMxcNativeEnv(resolveMxcNativeBinaries(config.mxcBinaryPath));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`[mxc] MXC sandbox backend cannot load: ${reason}`, { cause: err });
  }
  assertMxcReadiness({ nativeEnv });

  // Advisory: warn (don't block) when the system drive lacks AppContainer
  // directory-access ACEs, which only degrades in-sandbox directory listing.
  warnMxcHostPrepIfNeeded();

  const unregister = registerSandboxBackend("mxc", {
    factory: createMxcSandboxBackendFactory(config),
    manager: mxcSandboxBackendManager,
  });

  // Eager CLI registrations must retire even if Gateway services never start.
  api.lifecycle.registerRuntimeLifecycle({
    id: "mxc-sandbox-cleanup",
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
