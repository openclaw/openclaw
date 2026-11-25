import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  decodeOpenAICodexJwtPayload,
  isFailedOAuthRefreshFence,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createOpenAIProviderMetadata } from "./provider-metadata.js";
import { resolveFastModeSupport, resolveServiceTiers } from "./provider-policy-api.js";
import { isSIWCAuthFlow } from "./token-sharing.js";

const matchesTokenSharingAccount: NonNullable<
  ProviderPlugin["auth"][number]["matchesPersonalAccount"]
> = (credential, existing) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== "openai" ||
    existing.provider !== "openai" ||
    !isSIWCAuthFlow(credential.authFlow) ||
    !isSIWCAuthFlow(existing.authFlow) ||
    !credential.idToken ||
    !existing.idToken ||
    !credential.clientId ||
    credential.clientId !== existing.clientId
  ) {
    return false;
  }
  // Issuance verified these ID tokens; decoding here only compares persisted subjects.
  const current = decodeOpenAICodexJwtPayload(credential.idToken);
  const previous = decodeOpenAICodexJwtPayload(existing.idToken);
  return Boolean(current?.sub && current.sub === previous?.sub && current.iss === previous?.iss);
};

function accountSubject(token: string | undefined) {
  const claims = asNonArrayRecord(
    token && decodeOpenAICodexJwtPayload(token)?.["https://api.openai.com/auth"],
  );
  return {
    accountId: normalizeOptionalString(claims.chatgpt_account_id),
    userId:
      normalizeOptionalString(claims.chatgpt_user_id) ?? normalizeOptionalString(claims.user_id),
  };
}

const matchesPersonalAccount: NonNullable<
  ProviderPlugin["auth"][number]["matchesPersonalAccount"]
> = (credential, existing) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== "openai" ||
    existing.provider !== credential.provider
  ) {
    return false;
  }
  // A ChatGPT account is a workspace, not a person. Reconnect also requires
  // the exact user; missing claims must not replace any owned credential.
  const subject = accountSubject(credential.access);
  const previous = accountSubject(existing.access);
  return Boolean(
    subject.accountId &&
    subject.userId &&
    previous.accountId === subject.accountId &&
    previous.userId === subject.userId,
  );
};

const matchesSharedAccount: NonNullable<ProviderPlugin["auth"][number]["matchesSharedAccount"]> = (
  credential,
  existing,
) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    credential.provider !== "openai" ||
    existing.provider !== credential.provider ||
    isSIWCAuthFlow(credential.authFlow) ||
    isSIWCAuthFlow(existing.authFlow)
  ) {
    return false;
  }
  const incoming = accountSubject(credential.access);
  const savedAccess = accountSubject(existing.access);
  // Stable Codex imports can retain the workspace separately and keep the ID
  // token with the user claim missing from the saved access token.
  const savedId = accountSubject(existing.idToken);
  const workspaces = [
    savedAccess.accountId,
    savedId.accountId,
    normalizeOptionalString(existing.accountId),
  ];
  const users = [savedAccess.userId, savedId.userId];
  return Boolean(
    incoming.accountId &&
    incoming.userId &&
    workspaces.includes(incoming.accountId) &&
    workspaces.every((id) => !id || id === incoming.accountId) &&
    users.includes(incoming.userId) &&
    users.every((id) => !id || id === incoming.userId),
  );
};

const canReplaceGeneratedProfile: NonNullable<
  ProviderPlugin["auth"][number]["canReplaceGeneratedProfile"]
> = (credential, existing) => {
  if (
    credential.type !== "oauth" ||
    existing.type !== "oauth" ||
    existing.provider !== credential.provider ||
    isSIWCAuthFlow(existing.authFlow)
  ) {
    return false;
  }
  if (matchesSharedAccount(credential, existing)) {
    return true;
  }
  if (!isFailedOAuthRefreshFence(existing)) {
    return false;
  }
  // The fence drops the old access-token subject. Only recover this generated
  // slot if both the workspace and the provider-verified email still match.
  const incoming = resolveOpenAICodexAuthIdentity({ access: credential.access });
  const claims = asNonArrayRecord(
    decodeOpenAICodexJwtPayload(credential.access)?.["https://api.openai.com/profile"],
  );
  return Boolean(
    incoming.accountId &&
    incoming.accountId === normalizeOptionalString(existing.accountId) &&
    claims.email_verified === true &&
    incoming.email &&
    incoming.email === normalizeOptionalString(existing.email),
  );
};

export function createOpenAIProvider(): ProviderPlugin {
  const provider = createOpenAIProviderMetadata();
  for (const method of provider.auth) {
    if (method.kind === "oauth" || method.kind === "device_code") {
      method.matchesPersonalAccount =
        method.id === "siwc" ? matchesTokenSharingAccount : matchesPersonalAccount;
      if (method.id !== "siwc") {
        method.matchesSharedAccount = matchesSharedAccount;
        method.canReplaceGeneratedProfile = canReplaceGeneratedProfile;
      }
    }
  }
  return { ...provider, resolveFastModeSupport, resolveServiceTiers };
}
