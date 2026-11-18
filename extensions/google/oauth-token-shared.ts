import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";

export function parseGoogleOauthApiKey(apiKey: string): {
  token?: string;
  projectId?: string;
} | null {
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown; projectId?: unknown };
    return {
      token: readStringValue(parsed.token),
      projectId: readStringValue(parsed.projectId),
    };
  } catch {
    return null;
  }
}

export function formatGoogleOauthApiKey(cred: {
  type?: string;
  access?: string;
  projectId?: string;
}): string {
  if (cred.type !== "oauth" || typeof cred.access !== "string" || !cred.access.trim()) {
    return "";
  }
  return JSON.stringify({
    token: cred.access,
    projectId: cred.projectId,
  });
}
