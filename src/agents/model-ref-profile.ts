export function splitTrailingAuthProfile(raw: string): {
  model: string;
  profile?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { model: "" };
  }

  for (let profileDelimiter = trimmed.indexOf("@"); profileDelimiter > 0; ) {
    const model = trimmed.slice(0, profileDelimiter).trim();
    const profile = trimmed.slice(profileDelimiter + 1).trim();
    if (model && profile && !profile.includes("/")) {
      return { model, profile };
    }
    profileDelimiter = trimmed.indexOf("@", profileDelimiter + 1);
  }
  return { model: trimmed };
}
