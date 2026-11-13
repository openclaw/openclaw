import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { decodeOpenAICodexJwtPayload } from "openclaw/plugin-sdk/provider-oauth-runtime";
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

function accountSubject(access: string): { accountId: string; userId: string } | undefined {
  const claims = asNonArrayRecord(
    decodeOpenAICodexJwtPayload(access)?.["https://api.openai.com/auth"],
  );
  const accountId = normalizeOptionalString(claims.chatgpt_account_id);
  const userId =
    normalizeOptionalString(claims.chatgpt_user_id) ?? normalizeOptionalString(claims.user_id);
  return accountId && userId ? { accountId, userId } : undefined;
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
    subject && previous?.accountId === subject.accountId && previous.userId === subject.userId,
  );
};

export function createOpenAIProvider(): ProviderPlugin {
  const provider = createOpenAIProviderMetadata();
  for (const method of provider.auth) {
    if (method.kind === "oauth" || method.kind === "device_code") {
      method.matchesPersonalAccount =
        method.id === "siwc" ? matchesTokenSharingAccount : matchesPersonalAccount;
    }
  }
  return { ...provider, resolveFastModeSupport, resolveServiceTiers };
}
