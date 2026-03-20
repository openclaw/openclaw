import type { AuthProfileStore } from "./auth-profiles.js";

export type GigachatAuthMetadata = Record<string, string> | undefined;

export function resolveGigachatAuthProfileMetadata(
  store: Pick<AuthProfileStore, "profiles">,
  authProfileId?: string,
  options?: {
    allowDefaultProfileFallback?: boolean;
  },
): GigachatAuthMetadata {
  const profileIds = [
    authProfileId?.trim(),
    options?.allowDefaultProfileFallback === false ? undefined : "gigachat:default",
  ].filter((profileId): profileId is string => Boolean(profileId));
  for (const profileId of profileIds) {
    const credential = store.profiles[profileId];
    if (credential?.type === "api_key" && credential.provider === "gigachat") {
      return credential.metadata;
    }
  }
  return undefined;
}

export function resolveGigachatInsecureTlsOverride(
  metadata?: GigachatAuthMetadata,
): boolean | undefined {
  if (metadata?.insecureTls === "true") {
    return true;
  }
  if (metadata?.insecureTls === "false") {
    return false;
  }
  return undefined;
}

function looksLikeGigachatBasicCredentials(apiKey: string | undefined): boolean {
  const trimmed = apiKey?.trim();
  if (!trimmed) {
    return false;
  }
  const separatorIndex = trimmed.indexOf(":");
  // OAuth credential keys can legitimately contain additional ":" segments, so
  // only infer Basic auth for the obvious single-separator user:password shape.
  return separatorIndex > 0 && separatorIndex === trimmed.lastIndexOf(":");
}

export function resolveGigachatAuthMode(params: {
  metadata?: GigachatAuthMetadata;
  apiKey?: string;
  authProfileId?: string;
}): "oauth" | "basic" {
  const metadataAuthMode = params.metadata?.authMode;
  if (metadataAuthMode === "basic" || metadataAuthMode === "oauth") {
    return metadataAuthMode;
  }

  if (looksLikeGigachatBasicCredentials(params.apiKey)) {
    return "basic";
  }

  return "oauth";
}
