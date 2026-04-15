import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  mergeImplicitMantleProvider,
  resolveImplicitMantleProvider,
  resolveMantleBearerToken,
} from "./discovery.js";

type MantlePluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

export function registerBedrockMantlePlugin(api: OpenClawPluginApi): void {
  const providerId = "amazon-bedrock-mantle";
  const pluginConfig = (api.pluginConfig ?? {}) as MantlePluginConfig;
  const discoveryEnabled = pluginConfig.discovery?.enabled;

  api.registerProvider({
    id: providerId,
    label: "Amazon Bedrock Mantle (OpenAI-compatible)",
    docsPath: "/providers/bedrock-mantle",
    auth: [],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        // Honor explicit discovery.enabled gate — when set to false, skip
        // discovery entirely so the plugin stays quiet when not in use.
        if (discoveryEnabled === false) {
          return null;
        }
        const implicit = await resolveImplicitMantleProvider({
          env: ctx.env,
        });
        if (!implicit) {
          return null;
        }
        return {
          provider: mergeImplicitMantleProvider({
            existing: ctx.config.models?.providers?.[providerId],
            implicit,
          }),
        };
      },
    },
    resolveConfigApiKey: ({ env }) =>
      resolveMantleBearerToken(env) ? "AWS_BEARER_TOKEN_BEDROCK" : undefined,
    matchesContextOverflowError: ({ errorMessage }) =>
      /context_length_exceeded|max.*tokens.*exceeded/i.test(errorMessage),
    classifyFailoverReason: ({ errorMessage }) => {
      if (/rate_limit|too many requests|429/i.test(errorMessage)) {
        return "rate_limit";
      }
      if (/overloaded|503/i.test(errorMessage)) {
        return "overloaded";
      }
      return undefined;
    },
  });
}
