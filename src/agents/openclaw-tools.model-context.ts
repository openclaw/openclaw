import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WebSearchProviderToolExecutionContext } from "../plugins/web-provider-types.js";
import { resolveAgentDir } from "./agent-scope.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-selection.js";

export type ModelAwareToolContext = {
  agentDir?: string;
  /** Lifecycle generation prepared for the active run. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  /** Auth profiles already loaded for prompt-time tool availability. */
  authProfileStore?: AuthProfileStore;
  /** Source detection prepared without loading credentials during tool selection. */
  authProfileStoreSource?: boolean;
  /** Whether the active model accepts image content natively; this does not load arbitrary files. */
  modelHasVision?: boolean;
  /** Active provider/model pair used for tool gating. */
  modelProvider?: string;
  modelId?: string;
  /** Exact host-selected credential owner for model-backed tool calls. */
  modelAuthProfileId?: string;
  /** Standalone tool invocation selection; does not change other tools' model eligibility. */
  webSearchModelSelection?: WebSearchProviderToolExecutionContext["modelSelection"];
  /** Effective context ceiling for selected-model model-visible projections. */
  modelContextWindowTokens?: number;
  /** Explicit agent ID override for cron and hook sessions. */
  requesterAgentIdOverride?: string;
};

/** Preserve configured credential pins only for the same selected provider/model. */
export function resolveWebSearchToolContext(
  cfg: OpenClawConfig,
  agentId: string,
  options?: ModelAwareToolContext,
): { agentDir: string; modelSelection: WebSearchProviderToolExecutionContext["modelSelection"] } {
  const configured = resolveSimpleCompletionSelectionForAgent({ cfg, agentId });
  const selected =
    options?.webSearchModelSelection ??
    (options?.modelProvider && options.modelId
      ? {
          provider: options.modelProvider,
          model: options.modelId,
          authProfileId: options.modelAuthProfileId,
        }
      : configured
        ? {
            provider: configured.provider,
            model: configured.modelId,
            authProfileId: configured.profileId,
          }
        : undefined);
  return {
    agentDir: options?.agentDir ?? resolveAgentDir(cfg, agentId),
    modelSelection: selected
      ? {
          ...selected,
          authProfileId:
            selected.authProfileId ??
            (configured &&
            selected.provider === configured.provider &&
            selected.model === configured.modelId
              ? configured.profileId
              : undefined),
        }
      : undefined,
  };
}
