import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import type { ResolvedProviderAuth } from "./model-auth.js";

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
  useUtilityModel?: boolean;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<ResolvedProviderAuth["mode"]>;
  allowBundledStaticCatalogFallback?: boolean;
  /** @deprecated no-op; kept for plugin-SDK source compatibility, remove at next SDK-breaking window. */
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: typeof resolveModelAsync;
};
