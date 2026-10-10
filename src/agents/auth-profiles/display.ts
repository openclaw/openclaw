import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAuthProfileMetadata } from "./identity.js";
import type { AuthProfileStore } from "./types.js";

export function resolveAuthProfileDisplayLabel(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
}): string {
  const { displayName, email } = resolveAuthProfileMetadata(params);
  const label = displayName || email;
  return label ? `${params.profileId} (${label})` : params.profileId;
}
