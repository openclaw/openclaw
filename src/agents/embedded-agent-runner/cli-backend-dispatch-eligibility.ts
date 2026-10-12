// Dispatch and latency budgeting share this decision without loading the run machinery.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../../plugins/cli-backends.runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder,
  resolveModelAuthMode,
} from "../model-auth.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";

type EmbeddedCliBackendDispatchEligibilityParams = {
  provider?: string;
  model?: string;
  agentId?: string;
  /** Explicitly pinned auth profile for the run; decisive when it resolves. */
  authProfileId?: string;
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  preparedAuthStore?: AuthProfileStore;
};

function resolveDispatchProvider(
  params: EmbeddedCliBackendDispatchEligibilityParams,
): string | undefined {
  const backends = new Map(
    resolveRuntimeCliBackends("metadata").map((backend) => [
      normalizeProviderId(backend.id),
      backend,
    ]),
  );
  const requestedProvider = normalizeProviderId(params.provider ?? "");
  const provider = backends.has(requestedProvider)
    ? requestedProvider
    : normalizeProviderId(
        resolveCliRuntimeExecutionProvider({
          provider: params.provider ?? "",
          cfg: params.config,
          agentId: params.agentId,
          modelId: params.model,
          authProfileId: params.authProfileId,
          preparedAuthStore: params.preparedAuthStore,
        }) ?? "",
      );
  return backends.get(provider)?.subscriptionAuthDispatch ? provider : undefined;
}

function canDispatchWithAuthStore(
  params: EmbeddedCliBackendDispatchEligibilityParams,
  provider: string,
  store: AuthProfileStore,
): boolean {
  // A resolved pin wins; missing pins use the passthrough's ordered selection.
  const pinnedType = params.authProfileId
    ? store.profiles[params.authProfileId.trim()]?.type
    : undefined;
  // A store-wide "mixed" mode would mask an ordered subscription profile.
  const [selectedProfileId] = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider,
  });
  const selectedType =
    pinnedType ?? (selectedProfileId ? store.profiles[selectedProfileId]?.type : undefined);
  const authMode =
    selectedType === "api_key"
      ? "api-key"
      : selectedType === "oauth" || selectedType === "token"
        ? selectedType
        : resolveModelAuthMode(provider, params.config, store, {
            workspaceDir: params.workspaceDir,
          });
  return authMode !== "api-key" && authMode !== "mixed" && authMode !== "aws-sdk";
}

/** @deprecated Use resolveEmbeddedCliBackendDispatchEligibilityAsync for worker-owned reads. */
export function resolveEmbeddedCliBackendDispatchEligibility(
  params: EmbeddedCliBackendDispatchEligibilityParams,
): { provider: string } | undefined {
  const provider = resolveDispatchProvider(params);
  if (!provider) {
    return undefined;
  }
  try {
    const store =
      params.preparedAuthStore ??
      ensureAuthProfileStore(params.agentDir, { config: params.config });
    if (!canDispatchWithAuthStore(params, provider, store)) {
      return undefined;
    }
  } catch {
    // Unreadable stores keep the CLI best-effort path, as missing credentials do.
  }
  return { provider };
}

/** Reads credential metadata through its worker without materializing or refreshing secrets. */
export async function resolveEmbeddedCliBackendDispatchEligibilityAsync(
  params: EmbeddedCliBackendDispatchEligibilityParams,
): Promise<{ provider: string } | undefined> {
  const provider = resolveDispatchProvider(params);
  if (!provider) {
    return undefined;
  }
  try {
    const store =
      params.preparedAuthStore ??
      (await ensureAuthProfileStoreAsync(params.agentDir, { config: params.config }));
    if (!canDispatchWithAuthStore(params, provider, store)) {
      return undefined;
    }
  } catch {
    // Unreadable stores keep the CLI best-effort path, as missing credentials do.
  }
  return { provider };
}
