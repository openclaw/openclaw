type CodexJwtPayload = {
  iss?: unknown;
  sub?: unknown;
  "https://api.openai.com/profile"?: {
    email?: unknown;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_user_id?: unknown;
    chatgpt_user_id?: unknown;
    user_id?: unknown;
  };
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function decodeCodexJwtPayload(accessToken: string): CodexJwtPayload | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as CodexJwtPayload) : null;
  } catch {
    return null;
  }
}

export function resolveCodexStableSubject(payload: CodexJwtPayload | null): string | undefined {
  const auth = payload?.["https://api.openai.com/auth"];
  const accountUserId = normalizeNonEmptyString(auth?.chatgpt_account_user_id);
  if (accountUserId) {
    return accountUserId;
  }

  const userId =
    normalizeNonEmptyString(auth?.chatgpt_user_id) ?? normalizeNonEmptyString(auth?.user_id);
  if (userId) {
    return userId;
  }

  const iss = normalizeNonEmptyString(payload?.iss);
  const sub = normalizeNonEmptyString(payload?.sub);
  if (iss && sub) {
    return `${iss}|${sub}`;
  }
  return sub;
}

export function resolveCodexAuthIdentity(params: { accessToken: string; email?: string | null }): {
  email?: string;
  profileName?: string;
} {
  const payload = decodeCodexJwtPayload(params.accessToken);
  const email =
    normalizeNonEmptyString(payload?.["https://api.openai.com/profile"]?.email) ??
    normalizeNonEmptyString(params.email);
  if (email) {
    return { email, profileName: email };
  }

  const stableSubject = resolveCodexStableSubject(payload);
  if (!stableSubject) {
    return {};
  }

  return {
    profileName: `id-${Buffer.from(stableSubject).toString("base64url")}`,
  };
}
