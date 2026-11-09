/** Split an auth profile suffix without consuming model-version or quantization suffixes. */
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

  // A version may precede a quantization suffix; either can precede an auth profile.
  for (const suffix of [/^\d{8}(?:@|$)/, /^(?:i?q\d+(?:_[a-z0-9]+)*|\d+bit)(?:@|$)/i]) {
    if (!suffix.test(trimmed.slice(profileDelimiter + 1))) {
      continue;
    }
    const nextDelimiter = trimmed.indexOf("@", profileDelimiter + 1);
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

  return { model, profile };
}
