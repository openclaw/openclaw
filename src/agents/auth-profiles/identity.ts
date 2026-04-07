import type { OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { AuthProfileStore } from "./types.js";

function trimOptionalString(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value);
}

function resolveStoredMetadata(store: AuthProfileStore | undefined, profileId: string) {
  const profile = store?.profiles[profileId];
  if (!profile) {
    return {};
  }
  return {
    displayName: "displayName" in profile ? trimOptionalString(profile.displayName) : undefined,
    email: "email" in profile ? trimOptionalString(profile.email) : undefined,
  };
}

export function buildAuthProfileId(params: {
  providerId: string;
  profileName?: string | null;
  profilePrefix?: string;
}): string {
  const profilePrefix = trimOptionalString(params.profilePrefix) ?? params.providerId;
  const profileName = trimOptionalString(params.profileName) ?? "default";
  return `${profilePrefix}:${profileName}`;
}

export function resolveAuthProfileMetadata(params: {
  cfg?: OpenClawConfig;
  store?: AuthProfileStore;
  profileId: string;
}): { displayName?: string; email?: string } {
  const configured = params.cfg?.auth?.profiles?.[params.profileId];
  const stored = resolveStoredMetadata(params.store, params.profileId);
  return {
    displayName: trimOptionalString(configured?.displayName) ?? stored.displayName,
    email: trimOptionalString(configured?.email) ?? stored.email,
  };
}
