import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  AuthProfileStore,
  OAuthCredential,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { decodeOpenAICodexJwtPayload } from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { defaultCodexHome } from "./source.js";

const OPENAI_PROVIDER_ID = "openai";
export const LEGACY_CODEX_PROFILE_ID = "openai:default";

export type CodexAuthCredential =
  | {
      kind: "oauth";
      provider: typeof OPENAI_PROVIDER_ID;
      profileId: string;
      credential: OAuthCredential;
      configPatch: ProviderAuthResult["configPatch"];
    }
  | {
      kind: "api_key";
      provider: typeof OPENAI_PROVIDER_ID;
      profileId: string;
      key: string;
    };

export function findMatchingAuthProfile(
  store: AuthProfileStore,
  credential: CodexAuthCredential,
): string | undefined {
  const subject = credential.kind === "oauth" ? oauthSubject(credential.credential) : undefined;
  const provider =
    credential.kind === "oauth" ? credential.credential.provider : credential.provider;
  if (credential.kind === "oauth" && !subject) {
    return undefined;
  }
  for (const [profileId, existing] of Object.entries(store.profiles)) {
    if (existing.provider !== provider) {
      continue;
    }
    if (
      credential.kind === "api_key" &&
      existing.type === "api_key" &&
      existing.key === credential.key
    ) {
      return profileId;
    }
    if (subject && existing.type === "oauth") {
      const previous = oauthSubject(existing);
      if (previous?.accountId === subject.accountId && previous.userId === subject.userId) {
        return profileId;
      }
    }
  }
  return undefined;
}

function oauthSubject(credential: OAuthCredential) {
  const claims = decodeOpenAICodexJwtPayload(credential.access)?.["https://api.openai.com/auth"];
  if (!isRecord(claims)) {
    return undefined;
  }
  const accountId = readString(claims.chatgpt_account_id);
  const userId = readString(claims.chatgpt_user_id) ?? readString(claims.user_id);
  return accountId && userId ? { accountId, userId } : undefined;
}

export function itemProfileTarget(
  credential: CodexAuthCredential,
  store: AuthProfileStore,
  ctx: MigrationProviderContext,
  source: { codexHome: string },
): { profileId: string; matchedExisting: boolean } {
  const matched = findMatchingAuthProfile(store, credential);
  if (matched) {
    return { profileId: matched, matchedExisting: true };
  }
  if (credential.kind === "oauth") {
    const legacyProfile = ctx.config.auth?.profiles?.[LEGACY_CODEX_PROFILE_ID];
    // Explicit import can materialize the shipped CLI-backed slot without changing
    // model/session pins. Another source home or managed account must not fill it.
    const preserveLegacyProfile =
      legacyProfile?.provider === OPENAI_PROVIDER_ID &&
      legacyProfile.mode === "oauth" &&
      source.codexHome === defaultCodexHome() &&
      oauthSubject(credential.credential) !== undefined &&
      !Object.entries(store.profiles).some(
        ([id, existing]) =>
          id !== LEGACY_CODEX_PROFILE_ID &&
          existing.type === "oauth" &&
          existing.provider === OPENAI_PROVIDER_ID,
      );
    return {
      profileId: preserveLegacyProfile ? LEGACY_CODEX_PROFILE_ID : credential.profileId,
      matchedExisting: false,
    };
  }
  return { profileId: matched ?? credential.profileId, matchedExisting: Boolean(matched) };
}
