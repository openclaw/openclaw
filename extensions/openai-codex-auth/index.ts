import { loginOpenAICodex } from "@mariozechner/pi-ai";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const PROVIDER_ID = "openai-codex";
const PROVIDER_LABEL = "OpenAI Codex (ChatGPT OAuth)";
const DEFAULT_MODEL = "openai-codex/gpt-5.2";

const openaiCodexPlugin = {
  id: "openai-codex-auth",
  name: "OpenAI Codex Auth",
  description: "OAuth flow for OpenAI Codex (ChatGPT subscription)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/openai",
      aliases: ["codex", "chatgpt"],
      auth: [
        {
          id: "oauth",
          label: "ChatGPT OAuth",
          hint: "Sign in with your ChatGPT account",
          kind: "oauth",
          run: async (ctx) => {
            const spin = ctx.prompter.progress("Starting OpenAI Codex OAuth…");
            try {
              const creds = await loginOpenAICodex({
                onAuth: async (url) => {
                  if (ctx.isRemote) {
                    await ctx.prompter.note(
                      [
                        "Open this URL in your LOCAL browser:",
                        "",
                        url,
                        "",
                        "After signing in, paste the redirect URL back here.",
                      ].join("\n"),
                      "OpenAI Codex OAuth",
                    );
                    ctx.runtime.log("");
                    ctx.runtime.log("Copy this URL:");
                    ctx.runtime.log(url);
                    ctx.runtime.log("");
                  } else {
                    spin.update("Opening browser for sign-in…");
                    await ctx.openUrl(url);
                  }
                },
                onPrompt: async (message) => {
                  spin.update("Waiting for redirect URL…");
                  return String(await ctx.prompter.text({ message }));
                },
                onProgress: (msg) => spin.update(msg),
              });

              spin.stop("OpenAI Codex OAuth complete");

              if (!creds) {
                throw new Error("OAuth flow did not return credentials");
              }

              const profileId = `openai-codex:${creds.accountId ?? "default"}`;
              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: creds.accessToken,
                      refresh: creds.refreshToken,
                      expires: creds.expiresAt,
                      accountId: creds.accountId,
                    },
                  },
                ],
                configPatch: {
                  agents: {
                    defaults: {
                      models: {
                        [DEFAULT_MODEL]: {},
                      },
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "OpenAI Codex uses your ChatGPT subscription.",
                  "Models available depend on your subscription tier.",
                ],
              };
            } catch (err) {
              spin.stop("OpenAI Codex OAuth failed");
              await ctx.prompter.note(
                "Trouble with OAuth? See https://docs.openclaw.ai/providers/openai",
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

export default openaiCodexPlugin;
