import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfileWithLock,
  writeOAuthCredentials,
  type OAuthCredential,
} from "openclaw/plugin-sdk/provider-auth";

export const GMAIL_PROVIDER_ID = "google-gmail";

export type GmailStoredProfile = {
  profileId: string;
  email?: string;
  displayName?: string;
  expires?: number;
};

function isOAuthCredential(value: unknown): value is OAuthCredential {
  return !!value && typeof value === "object" && (value as { type?: string }).type === "oauth";
}

export function listGmailStoredProfiles(agentDir?: string): GmailStoredProfile[] {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  return listProfilesForProvider(store, GMAIL_PROVIDER_ID)
    .map((profileId) => {
      const credential = store.profiles[profileId];
      if (!isOAuthCredential(credential)) {
        return null;
      }
      return {
        profileId,
        email: credential.email,
        displayName: credential.displayName,
        expires: credential.expires,
      };
    })
    .filter((value): value is GmailStoredProfile => value !== null);
}

export function resolveStoredGmailCredential(params: { agentDir?: string; profileId?: string }): {
  profileId: string;
  credential: OAuthCredential;
} {
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const candidateIds = params.profileId
    ? [params.profileId]
    : listProfilesForProvider(store, GMAIL_PROVIDER_ID);

  for (const profileId of candidateIds) {
    const credential = store.profiles[profileId];
    if (isOAuthCredential(credential)) {
      return { profileId, credential };
    }
  }

  throw new Error("No Gmail OAuth profile is configured.");
}

export async function storeGmailOAuthCredentials(params: {
  agentDir?: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  displayName?: string;
}): Promise<string> {
  return await writeOAuthCredentials(
    GMAIL_PROVIDER_ID,
    {
      access: params.access,
      refresh: params.refresh,
      expires: params.expires,
      ...(params.email ? { email: params.email } : {}),
    },
    params.agentDir,
    {
      ...(params.email ? { profileName: params.email } : {}),
      ...(params.displayName ? { displayName: params.displayName } : {}),
    },
  );
}

export async function persistGmailRefresh(params: {
  agentDir?: string;
  profileId: string;
  credential: OAuthCredential;
}): Promise<void> {
  await upsertAuthProfileWithLock({
    agentDir: params.agentDir,
    profileId: params.profileId,
    credential: params.credential,
  });
}
