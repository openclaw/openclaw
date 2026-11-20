import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveNativeModelPrimary } from "../agent-scope-config.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../model-selection-config.js";
import { resolveModelCatalogIdentityKey } from "../openai-model-routes.js";

/** Shared preference precedence; readiness, rotation, persistence and authorization stay with their owners. */
export function resolveSessionAuthProfilePreference(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
  configuredProfileId?: string;
  sessionProfileId?: string;
  sessionProfileSource?: SessionEntry["authProfileOverrideSource"];
}):
  | { profileId: string; source: "user" | "auto"; origin: "session" | "model" | "automatic" }
  | undefined {
  const pinnedSession =
    params.sessionProfileSource === "user" || params.sessionProfileSource === "user-link";
  // Person-linked pins outrank the model's authored profile, including its matching default.
  const pinnedProfileId = pinnedSession ? params.sessionProfileId : undefined;
  const configuredProfile = splitTrailingAuthProfile(
    resolveNativeModelPrimary(params.cfg, params.agentId) ?? "",
  ).profile;
  const defaultModel = configuredProfile
    ? resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId })
    : undefined;
  const configuredProfileId =
    params.configuredProfileId?.trim() ||
    (defaultModel &&
    resolveModelCatalogIdentityKey({ provider: params.provider, id: params.modelId }) ===
      resolveModelCatalogIdentityKey({ provider: defaultModel.provider, id: defaultModel.model })
      ? configuredProfile
      : undefined);
  const profileId = pinnedProfileId ?? configuredProfileId ?? params.sessionProfileId;
  return profileId
    ? {
        profileId,
        source: pinnedProfileId || configuredProfileId ? "user" : "auto",
        origin: pinnedProfileId ? "session" : configuredProfileId ? "model" : "automatic",
      }
    : undefined;
}
