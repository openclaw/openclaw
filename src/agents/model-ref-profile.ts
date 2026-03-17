export function splitTrailingAuthProfile(raw: string): {
  model: string;
  profile?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }

  const lastSlash = trimmed.lastIndexOf("/");
  const profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
  if (profileDelimiter <= 0) {
    return { model: trimmed };
  }

  const potentialProfile = trimmed.slice(profileDelimiter + 1).trim();
  // Don't split if the part after @ looks like a version suffix (8 digits like YYYYMMDD)
  // This distinguishes model-id@20251001 (version suffix) from model-id@profile (auth profile)
  if (/^\d{8}$/.test(potentialProfile)) {
    return { model: trimmed };
  }

  const model = trimmed.slice(0, profileDelimiter).trim();
  const profile = potentialProfile;
  if (!model || !profile) {
    return { model: trimmed };
  }

  return { model, profile };
}
