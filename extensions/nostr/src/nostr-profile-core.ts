import { type NostrProfile, NostrProfileSchema } from "./config-schema.js";

/** NIP-01 profile content (JSON inside kind:0 event). */
export interface ProfileContent {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
}

const PROFILE_FIELDS = [
  ["name", "name"],
  ["displayName", "display_name"],
  ["about", "about"],
  ["picture", "picture"],
  ["banner", "banner"],
  ["website", "website"],
  ["nip05", "nip05"],
  ["lud16", "lud16"],
] as const;

/**
 * Convert our config profile schema to NIP-01 content format.
 * Strips undefined fields and validates URLs.
 */
export function profileToContent(profile: NostrProfile): ProfileContent {
  const validated = NostrProfileSchema.parse(profile);

  const content: ProfileContent = {};

  for (const [configKey, contentKey] of PROFILE_FIELDS) {
    const value = validated[configKey];
    if (value !== undefined) {
      content[contentKey] = value;
    }
  }

  return content;
}

/**
 * Convert NIP-01 content format back to our config profile schema.
 * Useful for importing existing profiles from relays.
 */
export function contentToProfile(content: ProfileContent): NostrProfile {
  const profile: NostrProfile = {};

  for (const [configKey, contentKey] of PROFILE_FIELDS) {
    const value = content[contentKey];
    if (value !== undefined) {
      profile[configKey] = value;
    }
  }

  return profile;
}
