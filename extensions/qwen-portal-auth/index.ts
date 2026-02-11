import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { loginQwenPortalOAuth } from "./oauth.js";

const PROVIDER_ID = "qwen-portal";
const PROVIDER_LABEL = "Qwen";
const DEFAULT_MODEL = "qwen-portal/qwen-plus";
const DEFAULT_BASE_URL_OAUTH = "https://portal.qwen.ai/v1";
const DEFAULT_BASE_URL_INTL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const DEFAULT_BASE_URL_CN = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const OAUTH_PLACEHOLDER = "qwen-oauth";

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL_OAUTH;
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

const qwenPortalPlugin = {
  id: "qwen-portal-auth",
  name: "Qwen OAuth & API Key",
  description: "OAuth flow and API key authentication for Qwen models",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/qwen",
      aliases: ["qwen"],
      auth: [
        {
          id: "device",
          label: "Qwen OAuth (Free)",
          hint: "Device code login - portal.qwen.ai",
          kind: "device_code",
          run: async (ctx) => {
            const progress = ctx.prompter.progress("Starting Qwen OAuth…");
            try {
              const result = await loginQwenPortalOAuth({
                openUrl: ctx.openUrl,
                note: ctx.prompter.note,
                progress,
              });

              progress.stop("Qwen OAuth complete");

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
                            id: "coder-model",
                            name: "Qwen Coder",
                            input: ["text"],
                          }),
                          buildModelDefinition({
                            id: "vision-model",
                            name: "Qwen Vision",
                            input: ["text", "image"],
                          }),
                        ],
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: {
                        "qwen-portal/coder-model": { alias: "qwen" },
                        "qwen-portal/vision-model": {},
                      },
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "Qwen OAuth tokens auto-refresh. Re-run login if refresh fails or access is revoked.",
                  `Base URL defaults to ${DEFAULT_BASE_URL_OAUTH}. Override models.providers.${PROVIDER_ID}.baseUrl if needed.`,
                ],
              };
            } catch (err) {
              progress.stop("Qwen OAuth failed");
              await ctx.prompter.note(
                "If OAuth fails, verify your Qwen account has portal access and try again.",
                "Qwen OAuth",
              );
              throw err;
            }
          },
        },
        {
          id: "api-key",
          label: "Qwen API Key",
          hint: "DashScope API key authentication",
          kind: "api_key",
          run: async (ctx) => {
            const region = await ctx.prompter.select({
              message: "Select Qwen DashScope region:",
              options: [
                {
                  value: "intl",
                  label: "International (Singapore) - dashscope-intl.aliyuncs.com",
                  hint: "For users outside mainland China",
                },
                {
                  value: "cn",
                  label: "China - dashscope.aliyuncs.com",
                  hint: "For users in mainland China",
                },
              ],
            });

            const apiKeyInput = await ctx.prompter.text({
              message: "Enter your Qwen API key:",
              placeholder: "sk-...",
              validate: (value) => {
                if (!value?.trim()) {
                  return "API key is required";
                }
                if (!value.startsWith("sk-")) {
                  return "Qwen API keys typically start with 'sk-'";
                }
                return undefined;
              },
            });

            const apiKey = String(apiKeyInput ?? "").trim();
            if (!apiKey) {
              throw new Error("API key is required");
            }

            const profileId = `${PROVIDER_ID}:default`;
            const baseUrl = region === "intl" ? DEFAULT_BASE_URL_INTL : DEFAULT_BASE_URL_CN;

            return {
              profiles: [
                {
                  profileId,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: apiKey,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl,
                      apiKey: `profile:${profileId}`,
                      api: "openai-completions",
                      models: [
                        buildModelDefinition({
                          id: "qwen-plus",
                          name: "Qwen Plus",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen-turbo",
                          name: "Qwen Turbo",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen-max",
                          name: "Qwen Max",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen-coder-plus",
                          name: "Qwen Coder Plus",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen3-coder-plus",
                          name: "Qwen3 Coder Plus",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen3-coder-flash",
                          name: "Qwen3 Coder Flash",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen3-max",
                          name: "Qwen3 Max",
                          input: ["text"],
                        }),
                        buildModelDefinition({
                          id: "qwen-vl-plus",
                          name: "Qwen Vision Plus",
                          input: ["text", "image"],
                        }),
                        buildModelDefinition({
                          id: "qwen3-vl-plus",
                          name: "Qwen3 Vision Plus",
                          input: ["text", "image"],
                        }),
                      ],
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: {
                      "qwen-portal/qwen-plus": { alias: "qwen" },
                      "qwen-portal/qwen-turbo": {},
                      "qwen-portal/qwen-max": {},
                      "qwen-portal/qwen3-max": {},
                      "qwen-portal/qwen-coder-plus": { alias: "qwen-coder" },
                      "qwen-portal/qwen3-coder-plus": { alias: "qwen3-coder" },
                      "qwen-portal/qwen3-coder-flash": {},
                      "qwen-portal/qwen-vl-plus": {},
                      "qwen-portal/qwen3-vl-plus": {},
                    },
                  },
                },
              },
              defaultModel: "qwen-portal/qwen-plus",
              notes: [
                `Using ${region === "intl" ? "International (Singapore)" : "China"} region`,
                "Qwen API key stored securely in auth profile.",
                region === "intl"
                  ? "Get your API key from: https://www.alibabacloud.com/help/en/model-studio/developer-reference/get-api-key"
                  : "Get your API key from: https://dashscope.aliyuncs.com/",
                "Supported models: qwen-plus, qwen-turbo, qwen-max, qwen3-max, qwen-coder-plus, qwen3-coder-plus, qwen3-coder-flash, qwen-vl-plus, qwen3-vl-plus",
              ],
            };
          },
        },
      ],
    });
  },
};

export default qwenPortalPlugin;
