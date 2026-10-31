import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { snapshotApiCredentials } from "./credential-persistence.js";
import { withZaloSendContext } from "./send-context.js";
import { getZaloSessionState } from "./session-runtime.js";
import {
  captureZalouserCredentialsEnv,
  loadStoredZaloCredentials,
  normalizeZalouserCredentialProfile as normalizeProfile,
  refreshStoredZaloCredentials,
} from "./session-state.js";
import type { ZaloSendHandoff } from "./types.js";
import { createZalo, type API } from "./zca-client.js";

const API_LOGIN_TIMEOUT_MS = 20_000;
type CredentialPersistenceMode = "persist" | "read-only";
export type CredentialPersistenceOptions = { credentialPersistence?: CredentialPersistenceMode };

async function ensureApi(
  profile: string,
  timeoutMs = API_LOGIN_TIMEOUT_MS,
  credentialPersistence: CredentialPersistenceMode = "persist",
): Promise<API> {
  const { apiByProfile, apiInitByProfile, credentials } = getZaloSessionState();
  const env = captureZalouserCredentialsEnv();
  const pendingRevocation = credentials.pendingRevocation(profile);
  if (pendingRevocation) {
    await pendingRevocation;
  }
  const cached = apiByProfile.get(profile);
  if (cached) {
    return cached;
  }

  const pending = apiInitByProfile.get(profile);
  if (pending) {
    return await pending;
  }

  const initPromise: Promise<API> = (async () => {
    const isCurrent = () => apiInitByProfile.get(profile) === initPromise;
    const stored = await loadStoredZaloCredentials(profile, env).catch(() => null);
    if (!stored || !isCurrent()) {
      throw new Error(`No saved Zalo session for profile "${profile}"`);
    }
    const zalo = await createZalo();
    const api = await withTimeout(
      zalo.login({
        imei: stored.imei,
        cookie: stored.cookie,
        userAgent: stored.userAgent,
        language: stored.language,
      }),
      timeoutMs,
      { message: `Timed out restoring Zalo session for profile "${profile}"` },
    );
    const persisted =
      credentialPersistence === "persist"
        ? await refreshStoredZaloCredentials(
            profile,
            snapshotApiCredentials(api, stored),
            isCurrent,
            env,
          )
        : stored;
    if (!isCurrent() || !persisted) {
      throw new Error(`Zalo session restore was superseded for profile "${profile}"`);
    }
    credentials.rememberCredentials(profile, persisted);
    apiByProfile.set(profile, api);
    return api;
  })();

  apiInitByProfile.set(profile, initPromise);
  try {
    return await initPromise;
  } finally {
    if (apiInitByProfile.get(profile) === initPromise) {
      apiInitByProfile.delete(profile);
    }
  }
}

export async function withZaloApi<T>(
  profileInput: string | null | undefined,
  operation: (api: API) => Promise<T>,
  options: {
    timeoutMs?: number;
    credentialPersistence?: CredentialPersistenceMode;
    handoff?: ZaloSendHandoff;
  } = {},
): Promise<T> {
  const { credentials } = getZaloSessionState();
  const profile = normalizeProfile(profileInput);
  const credentialPersistence = options.credentialPersistence ?? "persist";
  options.handoff?.signal?.throwIfAborted();
  options.handoff?.assertDirectAdapterHandoff?.();
  const api = await ensureApi(profile, options.timeoutMs, credentialPersistence);
  // Shared profile restoration must not inherit one waiting sender's lifetime.
  const result = options.handoff
    ? await withZaloSendContext(options.handoff, () => operation(api))
    : await operation(api);
  if (credentialPersistence === "persist") {
    await credentials.persistApiCredentialsIfChanged(profile, api);
  }
  return result;
}
