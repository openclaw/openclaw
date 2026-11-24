// Auth-profile checks that decide which OpenAI image route a request can use.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { resolveModelAuthPolicy } from "./provider-policy-api.js";

export type OpenAIImageModelAuth = Pick<
  OpenClawPluginApi["runtime"]["modelAuth"],
  "ensureAuthProfileStoreAsync" | "listProfilesForProvider" | "isProviderApiKeyConfiguredAsync"
>;

export async function resolveRequestAuthStore(
  req: { authStore?: AuthProfileStore; agentDir?: string },
  modelAuth: OpenAIImageModelAuth,
): Promise<AuthProfileStore | undefined> {
  if (req.authStore) {
    return req.authStore;
  }
  const agentDir = req.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  return modelAuth.ensureAuthProfileStoreAsync(agentDir, {
    allowKeychainPrompt: false,
  });
}

export function hasOpenAIImageApiKeyProfile(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  const profileIds = modelAuth.listProfilesForProvider(store, "openai");
  if (profileIds.length === 0) {
    return false;
  }
  return profileIds.some((profileId) => store.profiles[profileId]?.type === "api_key");
}

export function hasCodexResponseTransportProfileConfigured(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  return modelAuth.listProfilesForProvider(store, "openai").some((profileId) => {
    const credential = store.profiles[profileId];
    return isCodexImageSubscription(
      credential,
      credential?.type === "oauth" ? credential.chatgptPlanType : undefined,
    );
  });
}

function isCodexImageSubscription(
  credential: AuthProfileStore["profiles"][string] | undefined,
  planType?: string,
): credential is Extract<AuthProfileStore["profiles"][string], { type: "oauth" | "token" }> {
  return (
    (credential?.type === "oauth" || credential?.type === "token") &&
    resolveModelAuthPolicy({
      provider: "openai",
      mode: credential.type,
      authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
      planType,
      capability: "image-generation",
    })?.compatible === true
  );
}

// The auth policy filters logins whose stored plan is Free. Logins that never stored a
// plan still carry it in the access token, so read the claim first. Unknown plans pass.
export function isFreeChatGPTPlan(access: unknown, storedPlanType?: string): boolean {
  const planType =
    (typeof access === "string"
      ? resolveOpenAICodexAuthIdentity({ access }).chatgptPlanType
      : undefined) ?? storedPlanType;
  return planType?.trim().toLowerCase() === "free";
}

/** True when a ChatGPT sign-in that could otherwise reach the image routes is on the Free plan. */
export function hasFreeChatGPTPlanProfile(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  return modelAuth.listProfilesForProvider(store, "openai").some((profileId) => {
    const credential = store.profiles[profileId];
    if (!isCodexImageSubscription(credential)) {
      return false;
    }
    return credential.type === "oauth"
      ? isFreeChatGPTPlan(credential.access, credential.chatgptPlanType)
      : isFreeChatGPTPlan(credential.token);
  });
}
