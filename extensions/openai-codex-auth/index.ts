import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";

const PROVIDER_ID = "openai-codex-import";
const PROVIDER_LABEL = "OpenAI Codex CLI Import";

/**
 * Resolve the Codex auth file path, respecting CODEX_HOME env var like core does.
 * Called lazily to pick up env var changes.
 */
function getAuthFilePath(): string {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return path.join(codexHome, "auth.json");
}

/**
 * OpenAI Codex models available via ChatGPT Plus/Pro subscription.
 * Uses openai-codex/ prefix to match core provider namespace and avoid
 * conflicts with the standard openai/ API key-based provider.
 */
const CODEX_MODELS = [
  "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-5.2-codex",
] as const;

const DEFAULT_MODEL = "openai-codex/gpt-5.3-codex";

interface CodexAuthTokens {
  access_token: string;
  refresh_token?: string;
  account_id?: string;
  expires_at?: number;
}

interface CodexAuthFile {
  tokens?: CodexAuthTokens;
}

/**
 * Read the Codex CLI auth.json file, respecting CODEX_HOME env var.
 */
function readCodexAuth(): CodexAuthFile | null {
  try {
    const authFile = getAuthFilePath();
    if (!fs.existsSync(authFile)) return null;
    const content = fs.readFileSync(authFile, "utf-8");
    return JSON.parse(content) as CodexAuthFile;
  } catch {
    return null;
  }
}

/**
 * Decode JWT expiry timestamp from access token
 */
function decodeJwtExpiry(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString()) as { exp?: number };
    return decoded.exp ? decoded.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

const openaiCodexPlugin = {
  id: "openai-codex-auth",
  name: "OpenAI Codex Auth",
  description: "Use OpenAI models via Codex CLI authentication (ChatGPT Plus/Pro)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["codex-import"],

      auth: [
        {
          id: "codex-cli",
          label: "Codex CLI Auth",
          hint: "Import existing Codex CLI authentication (respects CODEX_HOME env var)",
          kind: "custom",

          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const spin = ctx.prompter.progress("Reading Codex CLI auth…");

            try {
              const auth = readCodexAuth();

              if (!auth?.tokens?.access_token) {
                spin.stop("No Codex auth found");
                await ctx.prompter.note(
                  "Run 'codex login' first to authenticate with OpenAI.\n\n" +
                    "Install Codex CLI: npm install -g @openai/codex\n" +
                    "Then run: codex login",
                  "Setup required",
                );
                throw new Error("Codex CLI not authenticated. Run: codex login");
              }

              spin.stop("Codex auth loaded");

              const profileId = `openai-codex-import:${auth.tokens.account_id ?? "default"}`;
              const expires = auth.tokens.expires_at
                ? auth.tokens.expires_at * 1000
                : decodeJwtExpiry(auth.tokens.access_token);

              const modelsConfig: Record<string, object> = {};
              for (const model of CODEX_MODELS) {
                modelsConfig[model] = {};
              }

              // Validate refresh token - empty/missing refresh tokens cause silent failures
              if (!auth.tokens.refresh_token) {
                spin.stop("Invalid Codex auth");
                await ctx.prompter.note(
                  "Your Codex CLI auth is missing a refresh token.\n\n" +
                    "Please re-authenticate: codex logout && codex login",
                  "Re-authentication required",
                );
                throw new Error(
                  "Codex CLI auth missing refresh token. Run: codex logout && codex login",
                );
              }

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: auth.tokens.access_token,
                      refresh: auth.tokens.refresh_token,
                      expires: expires ?? Date.now() + 3600000,
                    },
                  },
                ],
                configPatch: {
                  agents: {
                    defaults: {
                      models: modelsConfig,
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  `Using Codex CLI auth from ${getAuthFilePath()}`,
                  `Available models: ${CODEX_MODELS.join(", ")}`,
                  "Tokens auto-refresh when needed.",
                ],
              };
            } catch (err) {
              spin.stop("Failed to load Codex auth");
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default openaiCodexPlugin;
