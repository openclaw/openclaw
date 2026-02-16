import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROVIDER_ID = "openai-codex";
const PROVIDER_LABEL = "OpenAI Codex CLI";
const AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");

/**
 * OpenAI Codex models available via ChatGPT Plus/Pro subscription.
 * These are the models exposed through the Codex CLI OAuth tokens.
 */
const CODEX_MODELS = [
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/o1",
  "openai/o1-mini",
  "openai/o1-pro",
  "openai/o3",
  "openai/o3-mini",
  "openai/o4-mini",
] as const;

const DEFAULT_MODEL = "openai/o3";

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
 * Read the Codex CLI auth.json file from ~/.codex/auth.json
 */
function readCodexAuth(): CodexAuthFile | null {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const content = fs.readFileSync(AUTH_FILE, "utf-8");
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
      aliases: ["codex", "chatgpt"],

      auth: [
        {
          id: "codex-cli",
          label: "Codex CLI Auth",
          hint: "Use existing Codex CLI authentication from ~/.codex/auth.json",
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

              const profileId = `openai-codex:${auth.tokens.account_id ?? "default"}`;
              const expires = auth.tokens.expires_at
                ? auth.tokens.expires_at * 1000
                : decodeJwtExpiry(auth.tokens.access_token);

              const modelsConfig: Record<string, object> = {};
              for (const model of CODEX_MODELS) {
                modelsConfig[model] = {};
              }

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: auth.tokens.access_token,
                      refresh: auth.tokens.refresh_token ?? "",
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
                  "Using Codex CLI auth from ~/.codex/auth.json",
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
