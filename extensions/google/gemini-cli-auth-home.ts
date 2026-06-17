import crypto from "node:crypto";
import path from "node:path";

export const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
export const GEMINI_CLI_OAUTH_CREDS_RELATIVE_PATH = ".gemini/oauth_creds.json";

export function resolveGeminiCliProfileHome(agentDir: string, profileId: string): string {
  const profileHash = crypto.createHash("sha256").update(profileId).digest("hex").slice(0, 24);
  return path.join(agentDir, `${GOOGLE_GEMINI_CLI_PROVIDER_ID}-home`, "profiles", profileHash);
}

export function resolveGeminiCliProfileCredentialsPath(
  agentDir: string,
  profileId: string,
): string {
  return path.join(
    resolveGeminiCliProfileHome(agentDir, profileId),
    GEMINI_CLI_OAUTH_CREDS_RELATIVE_PATH,
  );
}
