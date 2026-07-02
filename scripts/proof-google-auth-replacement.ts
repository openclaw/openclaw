import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareGeminiCliAuthHome } from "../extensions/google/cli-backend-auth.runtime.js";
import { resolveGeminiCliProfileHome } from "../extensions/google/gemini-cli-auth-home.js";
import { resolveGoogleAuthCredential } from "../src/agents/auth-profiles/google.js";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";

const secretSentinels = {
  apiKey: "AIza-REAL-BEHAVIOR-PROOF-API-KEY-DO-NOT-LEAK",
  accessToken: "ya29.REAL-BEHAVIOR-PROOF-ACCESS-DO-NOT-LEAK",
  refreshToken: "1//REAL-BEHAVIOR-PROOF-REFRESH-DO-NOT-LEAK",
};

function redact(value: string): string {
  return Object.values(secretSentinels).reduce(
    (text, secret) => text.split(secret).join("[REDACTED]"),
    value,
  );
}

async function main() {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-auth-proof-"));
  const googleProfileId = "google:proof-api-key";
  const oauthProfileId = "google-gemini-cli:proof-oauth@example.test";
  const store: AuthProfileStore = {
    version: 1,
    order: {
      google: [googleProfileId],
      "google-gemini-cli": [oauthProfileId],
    },
    profiles: {
      [googleProfileId]: {
        type: "api_key",
        provider: "google",
        key: secretSentinels.apiKey,
      },
      [oauthProfileId]: {
        type: "oauth",
        provider: "google-gemini-cli",
        access: secretSentinels.accessToken,
        refresh: secretSentinels.refreshToken,
        expires: Date.now() + 3_600_000,
        projectId: "proof-project",
      },
    },
  };

  const apiKeyCredential = await resolveGoogleAuthCredential({
    providerId: "google",
    profileId: googleProfileId,
    agentDir,
    store,
  });
  const oauthCredential = await resolveGoogleAuthCredential({
    providerId: "google-gemini-cli",
    profileId: oauthProfileId,
    agentDir,
    store,
  });
  if (!apiKeyCredential || apiKeyCredential.kind !== "api_key") {
    throw new Error("google API-key profile did not resolve to an API-key credential");
  }
  if (!oauthCredential || oauthCredential.kind !== "oauth") {
    throw new Error("google-gemini-cli OAuth profile did not resolve to an OAuth credential");
  }

  const prepared = await prepareGeminiCliAuthHome(
    {
      agentDir,
      authProfileId: oauthProfileId,
      systemSettingsPath: undefined,
    },
    oauthCredential,
  );
  if (!prepared?.env?.GEMINI_CLI_HOME) {
    throw new Error("Gemini CLI OAuth preparation did not produce an isolated auth home");
  }
  await prepared.beforeExecution?.();
  const geminiHome = prepared.env.GEMINI_CLI_HOME;
  const oauthCredsPath = path.join(geminiHome, ".gemini", "oauth_creds.json");
  const oauthCredsRaw = await fs.readFile(oauthCredsPath, "utf8");
  const expectedProfileHash = crypto
    .createHash("sha256")
    .update(oauthProfileId)
    .digest("hex")
    .slice(0, 24);
  const expectedHome = resolveGeminiCliProfileHome(agentDir, oauthProfileId);

  const proof = {
    apiKeyProfileSelectedForGoogle: apiKeyCredential.profileId === googleProfileId,
    oauthProfileSelectedForGeminiCli: oauthCredential.profileId === oauthProfileId,
    geminiCliUsesIsolatedAuthHome: geminiHome === expectedHome,
    inheritedGoogleAuthEnvCleared: [
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_ACCESS_TOKEN",
      "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    ].every((name) => prepared.clearEnv?.includes(name)),
    apiKeyNotWrittenIntoGeminiCliOAuthFiles: !oauthCredsRaw.includes(secretSentinels.apiKey),
    oauthTokenValuesRedactedFromProofOutput: true,
    profileIdHashUsedInHome: geminiHome.includes(expectedProfileHash),
    rawProfileIdAbsentFromHome: !geminiHome.includes(oauthProfileId),
    selectedCredentialKinds: {
      google: apiKeyCredential.kind,
      "google-gemini-cli": oauthCredential.kind,
    },
    redactedCredentialFilePreview: redact(oauthCredsRaw),
  };

  const rendered = JSON.stringify(proof, null, 2);
  const leaked = Object.values(secretSentinels).filter((secret) => rendered.includes(secret));
  if (leaked.length > 0) {
    throw new Error("proof output leaked raw credential material");
  }
  console.log(rendered);
  await prepared.cleanup?.();
  await fs.rm(agentDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
