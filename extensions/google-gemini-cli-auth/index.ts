import {
  buildOauthProviderAuthResult,
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
} from "openclaw/plugin-sdk";
import { loginGeminiCliOAuth } from "./oauth.js";

const PROVIDER_ID = "google-gemini-cli";
const PROVIDER_LABEL = "Gemini CLI OAuth";
const DEFAULT_MODEL = "google-gemini-cli/gemini-3-pro-preview";
const ENV_VARS = [
  "OPENCLAW_GEMINI_OAUTH_CLIENT_ID",
  "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
];

const geminiCliPlugin = {
  id: "google-gemini-cli-auth",
  name: "Google Gemini CLI Auth",
  description: "OAuth flow for Gemini CLI (Google Code Assist)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["gemini-cli"],
      envVars: ENV_VARS,
      auth: [
        {
          id: "oauth",
          label: "Google OAuth",
          hint: "PKCE + localhost callback",
          kind: "oauth",
          run: async (ctx: ProviderAuthContext) => {
            const spin = ctx.prompter.progress("Starting Gemini CLI OAuth…");
            try {
              const result = await loginGeminiCliOAuth({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                log: (msg) => ctx.runtime.log(msg),
                note: ctx.prompter.note,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                progress: spin,
              });

              spin.stop("Gemini CLI OAuth complete");
              return buildOauthProviderAuthResult({
                providerId: PROVIDER_ID,
                defaultModel: DEFAULT_MODEL,
                access: result.access,
                refresh: result.refresh,
                expires: result.expires,
                email: result.email,
                credentialExtra: { projectId: result.projectId },
                notes: ["If requests fail, set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID."],
              });
            } catch (err) {
              spin.stop("Gemini CLI OAuth failed");
              await ctx.prompter.note(
                "Trouble with OAuth? Ensure your Google account has Gemini CLI access.",
                "OAuth help",
              );
              throw err;
            }
          },
        },
      ],
    });
  },
};

export default geminiCliPlugin;
