import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-oauth-runtime";
import type { OpenAIRealtimeHost } from "./realtime-host.js";
import type { OpenAIQuicksilverAuth } from "./realtime-quicksilver-wire.js";

// ChatGPT subscription credentials are either refreshable OAuth logins or pasted
// static access tokens. Readiness counts both; resolution prefers OAuth.
export const OPENAI_CHATGPT_SUBSCRIPTION_PROFILE_TYPES = ["oauth", "token"] as const;

export async function resolveOpenAIChatGptSubscriptionAuth(
  params: {
    cfg?: OpenClawConfig;
    agentDir?: string;
  },
  { resolveProviderAuthProfileApiKey }: OpenAIRealtimeHost,
): Promise<Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined> {
  const lookup = {
    provider: "openai",
    capability: "realtime-voice",
    cfg: params.cfg,
    agentDir: params.agentDir,
    includeExternalCliAuth: false,
  };
  const oauthToken = await resolveProviderAuthProfileApiKey({
    ...lookup,
    profileTypes: ["oauth"],
  });
  if (oauthToken) {
    const accountId = resolveOpenAICodexAuthIdentity({ access: oauthToken }).accountId;
    if (!accountId) {
      throw new Error("The selected ChatGPT OAuth profile is missing its account id");
    }
    return { type: "oauth", token: oauthToken, accountId };
  }
  // Token profiles may hold any pasted bearer; only a ChatGPT access token carries
  // the account claim. Others fall through to Platform auth instead of failing.
  const pastedToken = await resolveProviderAuthProfileApiKey({
    ...lookup,
    profileTypes: ["token"],
  });
  const accountId = pastedToken
    ? resolveOpenAICodexAuthIdentity({ access: pastedToken }).accountId
    : undefined;
  return pastedToken && accountId ? { type: "oauth", token: pastedToken, accountId } : undefined;
}
