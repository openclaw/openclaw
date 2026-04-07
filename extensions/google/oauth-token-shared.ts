type GoogleOauthApiKeyCredential = {
  type?: string;
  access?: string;
  projectId?: string;
};

export function parseGoogleOauthApiKey(apiKey: string): {
  token?: string;
  projectId?: string;
} | null {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown; projectId?: unknown };
    return {
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
    };
  } catch {
    return null;
  }
}

export function formatGoogleOauthApiKey(cred: GoogleOauthApiKeyCredential): string {
  if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) {
    return "";
  }
  return JSON.stringify({
    token: cred.access,
    projectId: cred.projectId,
  });
}

export function parseGoogleUsageToken(apiKey: string): string {
  const parsed = parseGoogleOauthApiKey(apiKey);
  if (parsed?.token) {
    return parsed.token;
  }

  // Keep the raw token when the stored credential is not a project-aware JSON payload.
  return apiKey;
}
