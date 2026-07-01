// Google API module exposes the plugin public contract.
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createGoogleProvider(): ProviderPlugin {
  return {
    id: "google",
    label: "Google AI Studio",
    docsPath: "/providers/models",
    hookAliases: ["google-antigravity", "google-vertex"],
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "Google Gemini API key",
        hint: "AI Studio / Gemini API key",
        run: noopAuth,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key",
        },
      },
    ],
  };
}

export function createGoogleVertexProvider(): ProviderPlugin {
  return {
    id: "google-vertex",
    label: "Google Vertex AI",
    docsPath: "/providers/models",
    envVars: [
      "GOOGLE_CLOUD_API_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    auth: [],
  };
}

export function createGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: "google-gemini-cli",
    label: "Gemini CLI OAuth",
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [
      "OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS",
      "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
      "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
      "GEMINI_CLI_OAUTH_CLIENT_ID",
      "GEMINI_CLI_OAUTH_CLIENT_SECRET",
    ],
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: "Google OAuth",
        hint: "PKCE + localhost callback; direct runtime registration requires OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1",
        run: noopAuth,
      },
    ],
    wizard: {
      setup: {
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        choiceHint: "Optional Gemini CLI OAuth harness; direct runtime registration requires OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1",
        methodId: "oauth",
      },
    },
  };
}
