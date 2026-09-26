import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import type { MiniMaxRegion } from "./oauth.js";
import { resolveMinimaxThinkingProfile } from "./thinking.js";

const noopAuth = async () => ({ profiles: [] });

export function minimaxAuthMethodMetadata(
  region: MiniMaxRegion,
  kind: "api_key" | "device_code",
): Omit<ProviderAuthMethod, "run"> {
  const isCn = region === "cn";
  const isApiKey = kind === "api_key";
  const label = `MiniMax ${isApiKey ? "API key" : "OAuth"} (${isCn ? "CN" : "Global"})`;
  const hint = isCn ? "CN endpoint - api.minimaxi.com" : "Global endpoint - api.minimax.io";
  return {
    id: isApiKey ? (isCn ? "api-cn" : "api-global") : isCn ? "oauth-cn" : "oauth",
    kind,
    label,
    hint,
    wizard: {
      choiceId: `minimax-${isCn ? "cn" : "global"}-${isApiKey ? "api" : "oauth"}`,
      choiceLabel: label,
      choiceHint: hint,
      groupId: "minimax",
      groupLabel: "MiniMax",
      groupHint: "M3 (recommended)",
    },
  };
}

function createMinimaxProviderContract(portal: boolean): ProviderPlugin {
  return {
    id: portal ? "minimax-portal" : "minimax",
    label: "MiniMax",
    hookAliases: [portal ? "minimax-portal-cn" : "minimax-cn"],
    docsPath: "/providers/minimax",
    envVars: portal ? ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"] : ["MINIMAX_API_KEY"],
    resolveThinkingProfile: ({ modelId }) => resolveMinimaxThinkingProfile(modelId),
    auth: (["global", "cn"] as const).map((region) =>
      Object.assign(minimaxAuthMethodMetadata(region, portal ? "device_code" : "api_key"), {
        run: noopAuth,
      }),
    ),
  };
}

export function createMinimaxProvider(): ProviderPlugin {
  return createMinimaxProviderContract(false);
}

export function createMinimaxPortalProvider(): ProviderPlugin {
  return createMinimaxProviderContract(true);
}
