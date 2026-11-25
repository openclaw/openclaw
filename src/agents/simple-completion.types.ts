import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

export type PrepareModelWithCredentialsParams = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  modelId: string;
  modelIdSource?: "input" | "selected";
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  authStore?: AuthProfileStore;
  /** Resolve the model again for the account the selected credential belongs to. */
  credentialScopedModelMetadata?: boolean;
  allowMissingApiKeyModes?: ReadonlyArray<ResolvedProviderAuth["mode"]>;
  allowBundledStaticCatalogFallback?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: SimpleCompletionModelResolver;
  /** Internal authorization wrappers around resolveModelAsync may keep single-row stores. */
  selectedModelStores?: boolean;
  signal?: AbortSignal;
  /** Internal caller-owned generation. Public plugin callers use the agent helper below. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  agentRuntimeId?: string;
  /** Internal stream callers own provider transport construction and embedded policy. */
  transport?: "simple-completion" | "provider-stream";
};

export type PrepareSimpleCompletionModelParams = PrepareModelWithCredentialsParams & {
  /** Internal worker RPC owner; sessionless helper callers cannot supply this authority. */
  workerInferenceAuthority?: { assertCurrent: () => void };
};

export type PreparedSimpleCompletionModel =
  | {
      model: Model;
      auth: ResolvedProviderAuth;
      /** Non-reversible owner proof captured from the same auth snapshot. */
      sourceAuthFingerprint?: string;
    }
  | {
      error: string;
      auth?: ResolvedProviderAuth;
    };

export type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  /** Shipped SDK return field; new selections carry canonical identity in provider. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};

export type PreparedSimpleCompletionModelForAgent =
  | (Extract<PreparedSimpleCompletionModel, { model: Model }> & {
      selection: AgentSimpleCompletionSelection;
    })
  | (Extract<PreparedSimpleCompletionModel, { error: string }> & {
      selection?: AgentSimpleCompletionSelection;
    });

export type PrepareSimpleCompletionModelForAgentParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  /** Prefer utility routing with true; "required" refuses primary fallback when no valid utility or explicit modelRef resolves. */
  useUtilityModel?: boolean | "required";
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<ResolvedProviderAuth["mode"]>;
  allowBundledStaticCatalogFallback?: boolean;
  /** @deprecated no-op; kept for plugin-SDK source compatibility, remove at next SDK-breaking window. */
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: SimpleCompletionModelResolver;
  signal?: AbortSignal;
};
