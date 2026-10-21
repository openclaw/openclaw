import { type NostrProfile, NostrProfileSchema } from "./config-schema.js";

/** NIP-01 profile content (JSON inside kind:0 event). */
export type ProfileContent = Omit<NostrProfile, "displayName"> & {
  display_name?: NostrProfile["displayName"];
};

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

/** Validates URLs and omits undefined fields for NIP-01 content. */
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
