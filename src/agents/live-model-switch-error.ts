/**
 * Carries the requested provider/model/auth-profile selection out of live
 * session setup code without treating the switch as a failure.
 */
export type LiveSessionModelSelection = {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

export class LiveSessionModelSwitchError extends Error {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";

  constructor(selection: LiveSessionModelSelection) {
    super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
    this.name = "LiveSessionModelSwitchError";
    this.provider = selection.provider;
    this.model = selection.model;
    this.agentRuntimeOverride = selection.agentRuntimeOverride;
    this.authProfileId = selection.authProfileId;
    this.authProfileIdSource = selection.authProfileIdSource;
  }
}
