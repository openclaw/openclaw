import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";

const PROVIDER_ID = "xai";
const XAI_OAUTH_METHOD_ID = "oauth";
const XAI_OAUTH_CHOICE_ID = "xai-oauth";

const loadXaiOAuthRuntime = createLazyRuntimeModule(() => import("./xai-oauth.js"));

const matchesSharedAccount: NonNullable<ProviderAuthMethod["matchesSharedAccount"]> = (
  credential,
  existing,
) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== PROVIDER_ID ||
    existing.provider !== PROVIDER_ID
  ) {
    return false;
  }
  // OAuth subjects are issuer-scoped. Equal email addresses do not identify an account.
  return Boolean(
    credential.issuer?.trim() &&
    credential.accountId?.trim() &&
    credential.issuer === existing.issuer &&
    credential.accountId === existing.accountId,
  );
};

export function createXaiOAuthAuthMethod(): ProviderAuthMethod {
  return {
    id: XAI_OAUTH_METHOD_ID,
    label: "xAI OAuth",
    hint: "Device-code sign-in; works over SSH and on remote hosts",
    kind: "oauth",
    matchesSharedAccount,
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
