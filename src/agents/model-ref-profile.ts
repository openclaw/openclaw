export function splitTrailingAuthProfile(raw: string): {
  model: string;
  profile?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }

  const profileDelimiter = trimmed.lastIndexOf("@");
  const lastSlash = trimmed.lastIndexOf("/");
  if (profileDelimiter <= 0 || profileDelimiter <= lastSlash) {
    return { model: trimmed };
  }

  const model = trimmed.slice(0, profileDelimiter).trim();
  const profile = trimmed.slice(profileDelimiter + 1).trim();
  if (!model || !profile) {
    return { model: trimmed };
  }

  return { model, profile };
}
