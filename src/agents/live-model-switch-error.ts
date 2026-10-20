/**
 * Carries the requested provider/model/auth-profile selection out of live
 * session setup code without treating the switch as a failure.
 */
export type LiveSessionModelSelection = {
  provider: string;
  model: string;
  /** The committed selection is an explicit session override rather than the default. */
  hasSessionModelOverride?: boolean;
  modelOverrideSource?: "auto" | "user";
  modelFallbackPolicy?: "configured";
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

export class LiveSessionModelSwitchError extends Error {
  provider: string;
  model: string;
  /**
   * Override status and source travel with the route: the retry owner rebuilds
   * fallback eligibility from them, so a policy change alone cannot describe
   * the committed selection.
   */
  hasSessionModelOverride: boolean;
  modelOverrideSource?: "auto" | "user";
  modelFallbackPolicy?: "configured";
  /** The switch grants or withdraws the interrupted attempt's fallback consent. */
  modelFallbackPolicyChanged: boolean;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";

  constructor(
    selection: LiveSessionModelSelection,
    interrupted: { modelFallbackPolicy?: "configured" } = {},
  ) {
    super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
    this.name = "LiveSessionModelSwitchError";
    this.provider = selection.provider;
    this.model = selection.model;
    this.hasSessionModelOverride = selection.hasSessionModelOverride === true;
    this.modelOverrideSource = this.hasSessionModelOverride
      ? selection.modelOverrideSource
      : undefined;
    this.modelFallbackPolicy = selection.modelFallbackPolicy;
    this.modelFallbackPolicyChanged =
      selection.modelFallbackPolicy !== interrupted.modelFallbackPolicy;
    this.agentRuntimeOverride = selection.agentRuntimeOverride;
    this.authProfileId = selection.authProfileId;
    this.authProfileIdSource = selection.authProfileIdSource;
  }
}
