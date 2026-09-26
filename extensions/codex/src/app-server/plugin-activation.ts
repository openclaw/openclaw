/**
 * Activates legacy curated Codex plugins while requiring owner-managed
 * installation for every other marketplace.
 */
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { CodexAppInventoryCache, CodexAppInventoryRequest } from "./app-inventory-cache.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
  type ResolvedCodexPluginPolicy,
} from "./config.js";
import {
  findCodexMarketplacePluginSummary,
  isOpenAiCuratedMarketplace,
  isOpenAiCuratedMarketplaceName,
  listCodexPluginMetadata,
  pluginReadParams,
  type CodexPluginMarketplaceRef,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { CodexAppServerRequestResult, v2 } from "./protocol.js";
import { CodexAppServerRpcError } from "./rpc-error.js";

/** Terminal reason reported after trying to activate one Codex plugin policy. */
type CodexPluginActivationReason =
  | "already_active"
  | "installed"
  | "disabled"
  | "marketplace_missing"
  | "plugin_missing"
  | "install_failed"
  | "auth_required"
  | "refresh_failed";

/** Human-readable diagnostic emitted during Codex plugin activation. */
type CodexPluginActivationDiagnostic = {
  message: string;
};

/** Result of ensuring one configured Codex plugin is installed and enabled. */
export type CodexPluginActivationResult = {
  identity: ResolvedCodexPluginPolicy;
  ok: boolean;
  reason: CodexPluginActivationReason;
  installAttempted: boolean;
  marketplace?: CodexPluginMarketplaceRef;
  installResponse?: v2.PluginInstallResponse;
  diagnostics: CodexPluginActivationDiagnostic[];
};

/** Inputs for activating one resolved Codex plugin policy. */
type EnsureCodexPluginActivationParams = {
  identity: ResolvedCodexPluginPolicy;
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  appInventoryCacheKey?: string;
  configCwd?: string;
  metadataCache?: CodexPluginMetadataCache;
  installEvenIfActive?: boolean;
  /** Thread setup batches app refresh once after all plugin activations. */
  deferAppInventoryRefresh?: boolean;
  targetAppIds?: readonly string[];
};

/** Diagnostics from refreshing Codex runtime surfaces after plugin activation. */
type CodexPluginRuntimeRefreshResult = {
  diagnostics: CodexPluginActivationDiagnostic[];
};

/** Activates legacy curated plugins without granting install authority to other marketplaces. */
export async function ensureCodexPluginActivation(
  params: EnsureCodexPluginActivationParams,
): Promise<CodexPluginActivationResult> {
  if (params.identity.marketplaceName === CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME) {
    return activationFailure(params.identity, "disabled", {
      message:
        "workspace-directory plugins must be installed and enabled outside OpenClaw before use.",
    });
  }
  if (!isOpenAiCuratedMarketplaceName(params.identity.marketplaceName)) {
    const target = params.identity.pluginName.endsWith(`@${params.identity.marketplaceName}`)
      ? params.identity.pluginName
      : `${params.identity.pluginName}@${params.identity.marketplaceName}`;
    return activationFailure(params.identity, "disabled", {
      message:
        `${params.identity.marketplaceName} plugins must be installed and enabled by an owner ` +
        `before use. Run /codex plugins install ${target}.`,
    });
  }

  const listed = await listCodexPluginMetadata(params, CODEX_PLUGINS_MARKETPLACE_NAME);
  const resolved = findCodexMarketplacePluginSummary(
    listed,
    params.identity.marketplaceName,
    params.identity.pluginName,
  );
  if (!resolved) {
    const hasCuratedMarketplace = listed.marketplaces.some((marketplace) =>
      isOpenAiCuratedMarketplace(marketplace),
    );
    if (!hasCuratedMarketplace) {
      return activationFailure(params.identity, "marketplace_missing", {
        message: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found.`,
      });
    }
    return activationFailure(params.identity, "plugin_missing", {
      message: `${params.identity.pluginName} was not found in ${CODEX_PLUGINS_MARKETPLACE_NAME}.`,
    });
  }

  if (resolved.marketplace.remoteMarketplaceName && !resolved.summary.remotePluginId) {
    return activationFailure(params.identity, "plugin_missing", {
      message: `${params.identity.pluginName} detail unavailable: Codex did not return a remote plugin id.`,
    });
  }

  if (
    resolved.summary.availability === "DISABLED_BY_ADMIN" ||
    resolved.summary.installPolicy === "NOT_AVAILABLE"
  ) {
    return activationFailure(params.identity, "disabled", {
      message: `${params.identity.pluginName} was disabled or made unavailable by its marketplace administrator.`,
    });
  }

  if (resolved.summary.installed && resolved.summary.enabled && !params.installEvenIfActive) {
    return {
      identity: params.identity,
      ok: true,
      reason: "already_active",
      installAttempted: false,
      marketplace: resolved.marketplace,
      diagnostics: [],
    };
  }

  const remotePluginId = resolved.marketplace.remoteMarketplaceName
    ? resolved.summary.remotePluginId
    : undefined;
  let installResponse: v2.PluginInstallResponse;
  try {
    installResponse = (await params.request(
      "plugin/install",
      pluginReadParams(
        resolved.marketplace,
        remotePluginId ?? params.identity.pluginName,
      ) satisfies v2.PluginInstallParams,
    )) as v2.PluginInstallResponse;
  } catch (error) {
    if (
      !(error instanceof CodexAppServerRpcError) ||
      error.code !== -32600 ||
      !remotePluginId ||
      (error.message !== `remote plugin ${remotePluginId} is disabled by admin` &&
        error.message !== `remote plugin ${remotePluginId} is not available for install`)
    ) {
      throw error;
    }
    // The catalog can be stale by install time. Isolate only Codex's exact
    // terminal remote-install contract; unrelated RPC failures abort the turn.
    return {
      identity: params.identity,
      ok: false,
      reason: "install_failed",
      installAttempted: true,
      marketplace: resolved.marketplace,
      diagnostics: [
        {
          message: `Codex plugin install failed: ${coerceErrorMessage(error)}`,
        },
      ],
    };
  }
  const refreshDiagnostics: CodexPluginActivationDiagnostic[] = [];
  let refreshFailed = false;
  try {
    const refreshResult = await refreshCodexPluginRuntimeState(params);
    refreshDiagnostics.push(...refreshResult.diagnostics);
  } catch (error) {
    refreshFailed = true;
    refreshDiagnostics.push({
      message: `Codex plugin runtime refresh failed after install: ${coerceErrorMessage(error)}`,
    });
  }
  const authRequired = installResponse.appsNeedingAuth.length > 0;
  return {
    identity: params.identity,
    ok: !authRequired && !refreshFailed,
    reason: refreshFailed
      ? "refresh_failed"
      : authRequired
        ? "auth_required"
        : resolved.summary.installed && resolved.summary.enabled
          ? "already_active"
          : "installed",
    installAttempted: true,
    marketplace: resolved.marketplace,
    installResponse,
    diagnostics: [
      ...refreshDiagnostics,
      ...installResponse.appsNeedingAuth.map((app) => ({
        message: `${app.name} requires app authentication before plugin tools are exposed.`,
      })),
    ],
  };
}

/** Refreshes OpenClaw inventories after Codex installs a plugin. */
export async function refreshCodexPluginRuntimeState(params: {
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  appInventoryCacheKey?: string;
  configCwd?: string;
  metadataCache?: CodexPluginMetadataCache;
  deferAppInventoryRefresh?: boolean;
  targetAppIds?: readonly string[];
}): Promise<CodexPluginRuntimeRefreshResult> {
  const diagnostics: CodexPluginActivationDiagnostic[] = [];
  if (params.appCacheKey) {
    params.metadataCache?.invalidate(params.appCacheKey);
  }
  await listCodexPluginMetadata(params, CODEX_PLUGINS_MARKETPLACE_NAME, { forceRefetch: true });

  if (params.appCache && params.appCacheKey) {
    try {
      await refreshCodexAppRuntimeState({
        ...params,
        appCache: params.appCache,
        appCacheKey: params.appInventoryCacheKey ?? params.appCacheKey,
      });
    } catch (error) {
      diagnostics.push({
        message: `Codex app inventory refresh skipped: ${coerceErrorMessage(error)}`,
      });
    }
  }

  return { diagnostics };
}

/** Refreshes hosted app tools without reloading unrelated active threads. */
export async function refreshCodexAppRuntimeState(params: {
  request: CodexPluginRuntimeRequest;
  appCache: CodexAppInventoryCache;
  appCacheKey: string;
  targetAppIds?: readonly string[];
  deferAppInventoryRefresh?: boolean;
}): Promise<void> {
  // Retire pre-refresh reads before any await. A failed refresh must leave the
  // previous snapshot stale, and a targeted refresh may only revalidate its apps.
  params.appCache.invalidate(
    params.appCacheKey,
    "Codex plugin app inventory refresh requested",
    undefined,
    params.targetAppIds,
  );
  if (params.deferAppInventoryRefresh) {
    return;
  }
  const request: CodexAppInventoryRequest = async (method, requestParams) =>
    (await params.request(method, requestParams)) as CodexAppServerRequestResult<typeof method>;
  await params.appCache.refreshNow({
    key: params.appCacheKey,
    request,
    forceRefetch: true,
    targetAppIds: params.targetAppIds,
  });
}

function activationFailure(
  identity: ResolvedCodexPluginPolicy,
  reason: CodexPluginActivationReason,
  diagnostic: CodexPluginActivationDiagnostic,
): CodexPluginActivationResult {
  return {
    identity,
    ok: false,
    reason,
    installAttempted: false,
    diagnostics: [diagnostic],
  };
}
