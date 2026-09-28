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
      result: ProviderAuthResult;
    }
  | {
      kind: "api_key";
      provider: typeof OPENAI_PROVIDER_ID;
      profileId: string;
      key: string;
    };

export function findMatchingOAuthProfile(
  store: AuthProfileStore,
  credential: OAuthCredential,
): string | undefined {
  const subject = oauthSubject(credential);
  if (!subject) {
    return undefined;
  }
  for (const [profileId, existing] of Object.entries(store.profiles)) {
    if (existing.type !== "oauth" || existing.provider !== credential.provider) {
      continue;
    }
    const previous = oauthSubject(existing);
    if (previous?.accountId === subject.accountId && previous.userId === subject.userId) {
      return profileId;
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

export function findMatchingApiKeyProfile(
  store: AuthProfileStore,
  provider: string,
  key: string,
): string | undefined {
  for (const [profileId, existing] of Object.entries(store.profiles)) {
    if (existing.type === "api_key" && existing.provider === provider && existing.key === key) {
      return profileId;
    }
  }
  return undefined;
}

export function itemProfileTarget(
  credential: CodexAuthCredential,
  store: AuthProfileStore,
  ctx: MigrationProviderContext,
  source: { codexHome: string },
): { profileId: string; matchedExisting: boolean } {
  if (credential.kind === "oauth") {
    const profile = credential.result.profiles[0];
    const matched =
      profile?.credential.type === "oauth"
        ? findMatchingOAuthProfile(store, profile.credential)
        : undefined;
    if (matched) {
      return { profileId: matched, matchedExisting: true };
    }
    const legacyProfile = ctx.config.auth?.profiles?.[LEGACY_CODEX_PROFILE_ID];
    // Explicit import can materialize the shipped CLI-backed slot without changing
    // model/session pins. Another source home or managed account must not fill it.
    const preserveLegacyProfile =
      legacyProfile?.provider === OPENAI_PROVIDER_ID &&
      legacyProfile.mode === "oauth" &&
      source.codexHome === defaultCodexHome() &&
      profile?.credential.type === "oauth" &&
      oauthSubject(profile.credential) !== undefined &&
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
  const matched = findMatchingApiKeyProfile(store, credential.provider, credential.key);
  return { profileId: matched ?? credential.profileId, matchedExisting: Boolean(matched) };
}
