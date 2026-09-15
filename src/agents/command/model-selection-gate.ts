import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import { resolveAgentEffectiveModelPrimary } from "../agent-scope.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { normalizeAgentCommandModelRef, parseAgentCommandModelRef } from "./model-ref.js";
import { normalizeExplicitOverrideInput } from "./prepare.js";

/**
 * Resolves the auth-profile suffix bound to an agent's effective default model
 * ref. Shared by execution (`configuredDefaultAuthProfileId`) and the standalone
 * prepare gate so both source the same configured-model binding.
 *
 * Kept in this lightweight module (not `command/model-selection.ts`) so the
 * standalone prepare entry can mirror execution's authority decision without
 * dragging the embedded model-selection runtime graph into the CLI bundle
 * (which trips the ineffective-dynamic-import build gate).
 */
export function resolveConfiguredModelAuthProfileId(
  cfg: OpenClawConfig,
  sessionAgentId: string,
): string | undefined {
  return splitTrailingAuthProfile(resolveAgentEffectiveModelPrimary(cfg, sessionAgentId) ?? "")
    .profile;
}

export type StandaloneModelIsDefaultParams = {
  cfg: OpenClawConfig;
  agentId: string;
  opts: { provider?: string; model?: string };
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  defaultProvider: string;
  defaultModel: string;
  allowPluginNormalization?: boolean;
  modelManifestContext: ModelManifestNormalizationContext;
};

/**
 * True when the standalone prepare path resolves to the configured default
 * provider/model after considering explicit and stored overrides (channel
 * overrides are intentionally out of scope here; see the PR body follow-up).
 *
 * This mirrors the authority gate used by execution
 * (`providerOverride === defaultProvider && modelOverride === defaultModel`),
 * but only over the sources the standalone prepare entry can decide exactly
 * (no run-context). A deliberate competing-implementation tradeoff: the pure
 * selection logic is mirrored here rather than extracted from the deep
 * catalog/visibility/auto-fallback path of `resolveEmbeddedModelSelection`.
 * Convergence onto a shared owner is tracked as a one-owner cutover follow-up.
 */
export function resolveStandaloneModelIsDefault(params: StandaloneModelIsDefaultParams): boolean {
  const { cfg, agentId, defaultProvider, defaultModel } = params;
  const explicitProvider = params.opts.provider?.trim()
    ? normalizeExplicitOverrideInput(params.opts.provider, "provider")
    : undefined;
  const explicitModel = params.opts.model?.trim()
    ? normalizeExplicitOverrideInput(params.opts.model, "model")
    : undefined;

  if (explicitProvider || explicitModel) {
    const ref = explicitModel
      ? explicitProvider
        ? normalizeAgentCommandModelRef(
            cfg,
            explicitProvider,
            explicitModel,
            params.modelManifestContext,
          )
        : parseAgentCommandModelRef(
            cfg,
            agentId,
            explicitModel,
            defaultProvider,
            params.modelManifestContext,
          )
      : normalizeAgentCommandModelRef(
          cfg,
          // SAFETY: explicitModel is falsy here, so explicitProvider is truthy per the '||' guard.
          explicitProvider as string,
          defaultModel,
          params.modelManifestContext,
        );
    if (ref) {
      return ref.provider === defaultProvider && ref.model === defaultModel;
    }
    return false;
  }

  const stored = resolveStoredModelOverride({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.sessionEntry?.parentSessionKey,
    defaultProvider,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  if (stored) {
    // Conservative: catalog alias resolution is skipped, so a stored override
    // that does not literally name the default is treated as non-default. This
    // leans toward not materializing (no #145740 regression) at the cost of
    // missing the rare stored-alias-that-resolves-to-default injection.
    const ref = normalizeAgentCommandModelRef(
      cfg,
      stored.provider ?? defaultProvider,
      stored.model,
      params.modelManifestContext,
    );
    return ref.provider === defaultProvider && ref.model === defaultModel;
  }

  return true;
}
