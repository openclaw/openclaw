import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";

const PROVIDER_ID = "xai";
const XAI_OAUTH_METHOD_ID = "oauth";
const XAI_OAUTH_CHOICE_ID = "xai-oauth";

const loadXaiOAuthRuntime = createLazyRuntimeModule(() => import("./xai-oauth.js"));

export function createXaiOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_OAUTH_METHOD_ID,
    label: "xAI OAuth",
    hint: "Device-code sign-in; works over SSH and on remote hosts",
    kind: "oauth",
    wizard: {
      choiceId: XAI_OAUTH_CHOICE_ID,
      choiceLabel: "xAI OAuth",
      choiceHint: "Device-code sign-in; works over SSH and on remote hosts",
      groupId: PROVIDER_ID,
      groupLabel: "xAI (Grok)",
      groupHint: "API key or OAuth",
      methodId: XAI_OAUTH_METHOD_ID,
    },
    run: async (ctx) => (await loadXaiOAuthRuntime()).loginXaiDeviceCode(ctx),
  };
}

export async function refreshXaiOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  return await (await loadXaiOAuthRuntime()).refreshXaiOAuthCredential(credential);
}
