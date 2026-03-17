/**
 * Check if a suffix looks like a version string rather than an auth profile.
 * Version suffixes are typically numeric dates (20251001) or semver-like (v1.2.3).
 * Auth profiles are alphanumeric names like "work", "default", or "cf:default".
 */
function looksLikeVersionSuffix(suffix: string): boolean {
  // Pure numeric (e.g., "20251001" for dates, "1234" for build numbers)
  if (/^\d+$/.test(suffix)) {
    return true;
  }
  // Semver-like patterns: v1, v1.2, v1.2.3, 1.2.3
  if (/^v?\d+(\.\d+)*(-[\w.]+)?(\+[\w.]+)?$/.test(suffix)) {
    return true;
  }
  return false;
}

export function splitTrailingAuthProfile(raw: string): {
  model: string;
  profile?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }

  const lastSlash = trimmed.lastIndexOf("/");
  let profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return { model: trimmed };
  }

  const versionSuffix = trimmed.slice(profileDelimiter + 1);
  if (/^\d{8}(?:@|$)/.test(versionSuffix)) {
    const nextDelimiter = trimmed.indexOf("@", profileDelimiter + 9);
    if (nextDelimiter < 0) {
      return { model: trimmed };
    }
    profileDelimiter = nextDelimiter;
  }

  const model = trimmed.slice(0, profileDelimiter).trim();
  const profile = trimmed.slice(profileDelimiter + 1).trim();
  if (!model || !profile) {
    return { model: trimmed };
  }

  // Don't split if the suffix looks like a version rather than an auth profile
  if (looksLikeVersionSuffix(profile)) {
    return { model: trimmed };
  }

  return { model, profile };
}
