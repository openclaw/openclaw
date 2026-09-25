import { resolveCodexAppServerLocalHomeDir } from "./auth-start-options.js";
import type {
  CodexBindingAppServerConnection,
  CodexBindingAppServerConnectionParams,
  CodexCatalogHomeDiscovery,
} from "./binding-connection.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./config-runtime.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";

/** Resolves connection and auth ownership exclusively from the private thread binding. */
export async function resolveCodexBindingAppServerConnection(
  params: CodexBindingAppServerConnectionParams,
  discoverHomes: CodexCatalogHomeDiscovery | null,
): Promise<CodexBindingAppServerConnection> {
  const { binding, authProfileId, assertCurrent, ...runtimeParams } = params;
  assertCurrent?.();
  const usesSupervisionConnection = binding?.connectionScope === "supervision";
  if (
    usesSupervisionConnection &&
    readCodexPluginConfig(runtimeParams.pluginConfig).supervision?.enabled !== true
  ) {
    throw new Error(
      "Codex supervision is disabled; refusing to open a native user-home supervised session",
    );
  }
  const resolveRuntimeOptions = usesSupervisionConnection
    ? resolveCodexSupervisionAppServerRuntimeOptions
    : resolveCodexAppServerRuntimeOptions;
  let appServer = resolveRuntimeOptions(runtimeParams);
  if (usesSupervisionConnection) {
    // Thread ids are connection-local. Every binding-owned operation must reject
    // config drift before a copied id can reach another native Codex store.
    const persistedFingerprint =
      binding.pendingSupervisionBranch?.connectionFingerprint ??
      binding.appServerRuntimeFingerprint;
    let currentFingerprint = buildCodexAppServerConnectionFingerprint(
      appServer,
      runtimeParams.agentDir,
    );
    if (
      persistedFingerprint &&
      currentFingerprint !== persistedFingerprint &&
      runtimeParams.agentDir
    ) {
      const homes = await discoverHomes?.(runtimeParams.agentDir);
      const home = homes?.find(
        (source) =>
          source.appServer.start.transport === "stdio" &&
          buildCodexAppServerConnectionFingerprint(source.appServer, source.agentDir) ===
            persistedFingerprint,
      );
      if (home) {
        home.assertCurrent();
        assertCurrent?.();
        // A miss stays rejected; a match keeps current policy and selects only its native store.
        appServer = resolveRuntimeOptions(runtimeParams);
        appServer = {
          ...appServer,
          start: {
            ...appServer.start,
            homeScope: "user",
            env: {
              ...appServer.start.env,
              CODEX_HOME: resolveCodexAppServerLocalHomeDir(
                home.appServer.start,
                home.agentDir,
                runtimeParams.env,
              ),
            },
          },
        };
        currentFingerprint = buildCodexAppServerConnectionFingerprint(
          appServer,
          runtimeParams.agentDir,
        );
      }
    }
    if (!persistedFingerprint || persistedFingerprint !== currentFingerprint) {
      throw new Error(
        "Codex supervision connection changed; refusing to operate on its bound native thread",
      );
    }
  }
  assertCurrent?.();
  return {
    appServer,
    usesSupervisionConnection,
    requestAuthProfileId: usesSupervisionConnection ? undefined : authProfileId,
    clientAuthProfileId:
      usesSupervisionConnection || appServer.start.homeScope === "user" ? null : authProfileId,
  };
}
