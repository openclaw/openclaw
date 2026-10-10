// Dispatch and latency budgeting share this decision without loading the run machinery.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../../plugins/cli-backends.runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  ensureAuthProfileStore,
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

/** Reads credential metadata only; never materializes or refreshes credentials per turn. */
export function resolveEmbeddedCliBackendDispatchEligibility(
  params: EmbeddedCliBackendDispatchEligibilityParams,
): { provider: string } | undefined {
  // Canonical refs must dispatch like explicit CLI-provider refs.
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
          // A profile pin can select the CLI runtime without agentRuntime config.
          authProfileId: params.authProfileId,
          preparedAuthStore: params.preparedAuthStore,
        }) ?? "",
      );
  // Only the backend plugin can declare subscription passthrough unsupported.
  if (!backends.get(provider)?.subscriptionAuthDispatch) {
    return undefined;
  }
  try {
    const store =
      params.preparedAuthStore ??
      ensureAuthProfileStore(params.agentDir, { config: params.config });
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
    // API-key stores keep direct passthrough; subscription or unresolved credentials use CLI.
    if (authMode === "api-key" || authMode === "mixed" || authMode === "aws-sdk") {
      return undefined;
    }
  } catch {
    // Unreadable stores keep the CLI best-effort path, as missing credentials do.
  }
  return { provider };
}
