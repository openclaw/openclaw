import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk";
import { loginOpenAICodexOAuth } from "./oauth.js";

const PROVIDER_ID = "openai-codex";
const PROVIDER_LABEL = "OpenAI Codex";
const DEFAULT_MODEL = "openai-codex/gpt-5.2";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const OAUTH_PLACEHOLDER = "openai-oauth";

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol.replace(/\/+$/, "")}/v1`;
}

function buildModelDefinition(params: {
  id: string;
  name: string;
  input: Array<"text" | "image">;
}) {
  return {
    id: params.id,
    name: params.name,
    reasoning: false,
    input: params.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

const openaiCodexPlugin = {
  id: "openai-codex-auth",
  name: "OpenAI Codex OAuth",
  description: "OAuth flow for OpenAI Codex models",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/openai",
      aliases: ["openai"],
      auth: [
        {
          id: "device",
          label: "OpenAI Codex OAuth",
          hint: "Device code login",
          kind: "device_code",
          run: async (ctx: ProviderAuthContext) => {
            const progress = ctx.prompter.progress("Starting OpenAI Codex OAuth…");
            try {
              const result = await loginOpenAICodexOAuth({
                openUrl: ctx.openUrl,
                note: ctx.prompter.note,
                progress,
              });

              progress.stop("OpenAI Codex OAuth complete");

              const profileId = `${PROVIDER_ID}:default`;
              const baseUrl = normalizeBaseUrl(result.resourceUrl);

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl,
                        apiKey: OAUTH_PLACEHOLDER,
                        api: "openai-completions",
                        models: [
                          buildModelDefinition({
                            id: "gpt-5.3-codex",
                            name: "Codex GPT-5.3",
                            input: ["text"],
                          }),
                          buildModelDefinition({
                            id: "gpt-5.2",
                            name: "Codex GPT-5.2",
                            input: ["text"],
                          }),
                          buildModelDefinition({
                            id: "gpt-5.4",
                            name: "Codex GPT-5.4",
                            input: ["text", "image"],
                          }),
                          buildModelDefinition({
                            id: "gpt-4o",
                            name: "Vision GPT-4o",
                            input: ["text", "image"],
                          }),
                        ],
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: {
                        "openai-codex/gpt-5.3-codex": { alias: "codex" },
                        "openai-codex/gpt-5.2": {},
                        "openai-codex/gpt-5.4": {},
                        "openai-codex/gpt-4o": {},
                      },
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "OpenAI Codex OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
                  `Base URL defaults to ${DEFAULT_BASE_URL}. Override models.providers.${PROVIDER_ID}.baseUrl if needed.`,
                ],
              };
            } catch (err) {
              progress.stop("OpenAI Codex OAuth failed");
              await ctx.prompter.note(
                "If OAuth fails, verify your OpenAI Codex account has access and try again.",
                "OpenAI Codex OAuth",
              );
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default openaiCodexPlugin;
