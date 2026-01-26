import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { extractKiroCliToken, isTokenExpired } from "./cli-credentials.js";
import { findKiroCli } from "./cli-detector.js";

const PROVIDER_ID = "kiro-cli";
const PROVIDER_LABEL = "Kiro CLI";
const DEFAULT_MODEL = "kiro-cli/auto";

const kiroPlugin = {
  id: "kiro-auth",
  name: "Kiro Auth",
  description: "Use kiro-cli for Kiro/Amazon Q Developer models",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["kiro", "amazon-q", "q-developer"],
      envVars: [],
      auth: [
        {
          id: "cli",
          label: "Use installed kiro-cli",
          hint: "Requires kiro-cli to be installed and authenticated",
          kind: "custom",
          run: async (ctx) => {
            const spin = ctx.prompter.progress("Checking kiro-cli...");

            // Check CLI is installed
            const cliPath = findKiroCli();
            if (!cliPath) {
              spin.stop("kiro-cli not found");
              await ctx.prompter.note(
                "Install kiro-cli first:\n\n" +
                  "  brew install kiro-cli\n" +
                  "  # or\n" +
                  "  curl -fsSL https://cli.kiro.dev/install | bash\n\n" +
                  "Then authenticate:\n" +
                  "  kiro-cli chat  # will prompt for login\n\n" +
                  "Note: On Windows, kiro-cli requires WSL2.",
                "Installation required",
              );
              throw new Error("kiro-cli not installed");
            }

            // Check credentials exist
            spin.update("Checking credentials...");
            const token = extractKiroCliToken();
            if (!token) {
              spin.stop("Not authenticated");
              await ctx.prompter.note(
                "Run `kiro-cli chat` to authenticate.\n" +
                  "The CLI will guide you through SSO login.",
                "Authentication required",
              );
              throw new Error(
                "kiro-cli not authenticated. Run `kiro-cli chat` first.",
              );
            }

            // Check token not expired
            if (isTokenExpired(token)) {
              spin.stop("Token expired");
              await ctx.prompter.note(
                "Your kiro-cli token has expired.\n" +
                  "Run `kiro-cli chat` to re-authenticate.",
                "Re-authentication required",
              );
              throw new Error(
                "kiro-cli token expired. Run `kiro-cli chat` to refresh.",
              );
            }

            spin.stop("kiro-cli ready");
            const profileId = "kiro:cli";

            return {
              profiles: [
                {
                  profileId,
                  credential: {
                    type: "oauth",
                    provider: PROVIDER_ID,
                    access: token.access_token,
                    refresh: token.refresh_token,
                    expires: new Date(token.expires_at).getTime(),
                  },
                },
              ],
              defaultModel: DEFAULT_MODEL,
              notes: [
                `Using kiro-cli at: ${cliPath}`,
                `Region: ${token.region}`,
              ],
            };
          },
        },
      ],
      refreshOAuth: async (cred) => {
        // Re-read token from SQLite - kiro-cli handles the actual OAuth refresh
        const token = extractKiroCliToken();
        if (!token || isTokenExpired(token)) {
          throw new Error(
            "kiro-cli token expired. Run `kiro-cli chat` to refresh.",
          );
        }
        return {
          ...cred,
          access: token.access_token,
          refresh: token.refresh_token,
          expires: new Date(token.expires_at).getTime(),
        };
      },
    });
  },
};

export default kiroPlugin;
