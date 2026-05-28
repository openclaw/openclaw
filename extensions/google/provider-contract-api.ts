// Google API module exposes the plugin public contract.
import type { OpenClawConfig, ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

const VERTEX_DEFAULT_MODEL = "google-vertex/gemini-flash-latest";
const VERTEX_DEFAULT_LOCATION = "global";

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
        hint: "Free API key from aistudio.google.com/apikey",
        run: noopAuth,
        wizard: {
          choiceId: "gemini-api-key",
          choiceLabel: "Google Gemini API key",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth",
        },
      },
    ],
  };
}

export function createGoogleVertexProvider(): ProviderPlugin {
  return {
    id: "google-vertex",
    label: "Google Vertex AI",
    docsPath: "/providers/google-vertex",
    envVars: [
      "GOOGLE_CLOUD_API_KEY",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
    auth: [
      {
        id: "adc",
        kind: "api_key" as const,
        label: "Google Cloud ADC",
        hint: "Application Default Credentials (GCE, GKE, gcloud, service account)",
        run: async (ctx: ProviderAuthContext) => {
          // Try to auto-detect project via google-auth-library
          let detectedProject: string | undefined;
          try {
            const { GoogleAuth } = await import("google-auth-library");
            const auth = new GoogleAuth({
              scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            });
            detectedProject = (await auth.getProjectId()) ?? undefined;
          } catch {
            // Auto-detection not available (not on GCE, no gcloud, etc.)
          }

          const projectPrompt = await ctx.prompter.text({
            message: "GCP project ID",
            ...(detectedProject
              ? {
                  placeholder: detectedProject,
                  initialValue: detectedProject,
                }
              : {
                  placeholder: "my-gcp-project",
                }),
          });
          const project =
            typeof projectPrompt === "string" && projectPrompt.trim()
              ? projectPrompt.trim()
              : detectedProject;
          if (!project) {
            await ctx.prompter.note(
              "A GCP project ID is required for Vertex AI. Set GOOGLE_CLOUD_PROJECT in your environment.",
              "Setup skipped",
            );
            return { profiles: [] };
          }

          const locationPrompt = await ctx.prompter.text({
            message: "GCP location",
            initialValue: VERTEX_DEFAULT_LOCATION,
            placeholder: VERTEX_DEFAULT_LOCATION,
          });
          const location =
            typeof locationPrompt === "string" && locationPrompt.trim()
              ? locationPrompt.trim()
              : VERTEX_DEFAULT_LOCATION;

          return {
            profiles: [
              {
                profileId: "google-vertex:default",
                credential: {
                  type: "api_key" as const,
                  provider: "google-vertex",
                  key: "gcp-vertex-credentials",
                },
              },
            ],
            defaultModel: VERTEX_DEFAULT_MODEL,
            configPatch: {
              env: {
                GOOGLE_CLOUD_PROJECT: project,
                GOOGLE_CLOUD_LOCATION: location,
              },
              models: {
                providers: {
                  "google-vertex": {
                    models: [
                      { id: "gemini-flash-latest", name: "Gemini Flash (latest)" },
                    ],
                  },
                },
              },
            } as unknown as Partial<OpenClawConfig>,
            notes: [
              `Project: ${project}, Location: ${location}`,
              "Credentials will be resolved via Application Default Credentials (ADC).",
              "On GCE/GKE/Cloud Run, the metadata server provides credentials automatically.",
              "With gcloud CLI, run: gcloud auth application-default login",
            ],
          };
        },
        wizard: {
          choiceId: "google-vertex-adc",
          choiceLabel: "Google Vertex AI (ADC)",
          groupId: "google",
          groupLabel: "Google",
          groupHint: "Gemini API key + OAuth + Vertex AI",
        },
      },
    ],
  };
}

export function createGoogleGeminiCliProvider(): ProviderPlugin {
  return {
    id: "google-gemini-cli",
    label: "Gemini CLI OAuth",
    docsPath: "/providers/models",
    aliases: ["gemini-cli"],
    envVars: [
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
        hint: "PKCE + localhost callback",
        run: noopAuth,
      },
    ],
    wizard: {
      setup: {
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        choiceHint: "Sign in with your Google account (opens a browser)",
        methodId: "oauth",
      },
    },
  };
}
