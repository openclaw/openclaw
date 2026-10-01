/**
 * Auth profile id and display metadata helpers.
 * Keeps profile id construction and human metadata lookup centralized for auth
 * status, storage, and provider selection.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore } from "./types.js";

/** Builds a provider-prefixed auth profile id. */
export function buildAuthProfileId(params: {
  providerId: string;
  profileName?: string | null;
  profilePrefix?: string;
}): string {
  const profilePrefix = normalizeOptionalString(params.profilePrefix) ?? params.providerId;
  const profileName = normalizeOptionalString(params.profileName) ?? "default";
  return `${profilePrefix}:${profileName}`;
}

/** Resolves display metadata for an auth profile from config/store. */
export function resolveAuthProfileMetadata(params: {
  cfg?: OpenClawConfig;
  store?: AuthProfileStore;
  profileId: string;
}): { displayName?: string; email?: string } {
  const configured = params.cfg?.auth?.profiles?.[params.profileId];
  const stored = params.store?.profiles[params.profileId];
  // Display labels can be configured without mutating stored credentials.
  return {
    displayName:
      normalizeOptionalString(configured?.displayName) ??
      normalizeOptionalString(stored?.displayName),
    email: normalizeOptionalString(configured?.email) ?? normalizeOptionalString(stored?.email),
  };
}
