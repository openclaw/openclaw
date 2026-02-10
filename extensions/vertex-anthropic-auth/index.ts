import { registerApiProvider } from "@mariozechner/pi-ai";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk";
import { streamAnthropicVertex, streamSimpleAnthropicVertex } from "./stream.js";

const VERTEX_API_TYPE = "anthropic-vertex-messages";

const DEFAULT_MODEL = "vertex-anthropic/claude-sonnet-4-5@20250929";

function validateEnv(): { projectId: string; region: string; keyFile?: string } {
  const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!projectId) {
    throw new Error("ANTHROPIC_VERTEX_PROJECT_ID environment variable is required");
  }

  const region = process.env.ANTHROPIC_VERTEX_REGION || "europe-west1";
  const keyFile =
    process.env.SERVICE_ACCOUNT_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  return { projectId, region, keyFile };
}

const vertexAnthropicPlugin = {
  id: "vertex-anthropic-auth",
  name: "Vertex AI Anthropic",
  description: "Anthropic Claude models via Google Cloud Vertex AI",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    registerApiProvider({
      api: VERTEX_API_TYPE,
      stream: streamAnthropicVertex,
      streamSimple: streamSimpleAnthropicVertex,
    });

    api.registerProvider({
      id: "vertex-anthropic",
      label: "Vertex AI Anthropic",
      docsPath: "/providers/vertex-anthropic",
      envVars: [
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "ANTHROPIC_VERTEX_REGION",
        "SERVICE_ACCOUNT_KEY_FILE",
      ],
      models: {
        baseUrl: "",
        api: VERTEX_API_TYPE as never,
        auth: "token",
        models: [
          {
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6 (Vertex)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
            contextWindow: 200000,
            maxTokens: 128000,
          },
          {
            id: "claude-sonnet-4-5@20250929",
            name: "Claude Sonnet 4.5 (Vertex)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            contextWindow: 200000,
            maxTokens: 64000,
          },
        ],
      },
      auth: [
        {
          id: "service-account",
          label: "GCP Service Account / ADC",
          hint: "Set ANTHROPIC_VERTEX_PROJECT_ID and optionally SERVICE_ACCOUNT_KEY_FILE",
          kind: "custom",
          run: async (ctx: ProviderAuthContext) => {
            const spin = ctx.prompter.progress("Validating Vertex AI credentials...");
            try {
              const { projectId, region, keyFile } = validateEnv();

              const authMethod = keyFile
                ? `service account key (${keyFile})`
                : "Application Default Credentials";

              spin.stop(`Vertex AI configured (project: ${projectId}, region: ${region})`);

              return {
                profiles: [
                  {
                    profileId: `vertex-anthropic:${projectId}`,
                    credential: {
                      type: "token" as const,
                      token: "vertex-ai-managed",
                    },
                  },
                ],
                defaultModel: DEFAULT_MODEL,
                notes: [
                  `Using ${authMethod} for Vertex AI authentication.`,
                  `Project: ${projectId}, Region: ${region}`,
                  "Token refresh is handled automatically by google-auth-library.",
                ],
              };
            } catch (err) {
              spin.stop("Vertex AI configuration failed");
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default vertexAnthropicPlugin;
