/**
 * Check if a suffix looks like a version string rather than an auth profile.
 * Version suffixes are typically numeric dates (20251001) or semver-like (v1.2.3).
 * Auth profiles are alphanumeric names like "work", "default", or "cf:default".
 *
 * Note: A purely numeric auth profile (e.g., @1234) would be mistakenly treated as
 * a version, but this is an unlikely edge case in practice.
 */
function looksLikeVersionSuffix(suffix: string): boolean {
  // Semver-like patterns: v1, v1.2, v1.2.3, 1.2.3, or pure numeric (e.g., "20251001" for dates)
  // Pure numeric strings match this pattern via the single \d+ group with optional parts absent.
  return /^v?\d+(\.\d+)*(-[\w.]+)?(\+[\w.]+)?$/.test(suffix);
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
