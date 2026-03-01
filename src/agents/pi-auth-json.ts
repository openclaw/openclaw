import path from "node:path";
import { getDatastore } from "../infra/datastore.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import {
  piCredentialsEqual,
  resolvePiCredentialMapFromStore,
  type PiCredential,
} from "./pi-auth-credentials.js";

/**
 * @deprecated Legacy bridge for older flows that still expect `agentDir/auth.json`.
 * Runtime auth resolution uses auth-profiles directly and should not depend on this module.
 */
type AuthJsonCredential = PiCredential;

type AuthJsonShape = Record<string, AuthJsonCredential>;

function readAuthJson(filePath: string): AuthJsonShape {
  try {
    const parsed = getDatastore().readJson(filePath) as AuthJsonShape | null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * pi-coding-agent's ModelRegistry/AuthStorage expects credentials in auth.json.
 *
 * OpenClaw stores credentials in auth-profiles.json instead. This helper
 * bridges all credentials into agentDir/auth.json so pi-coding-agent can
 * (a) consider providers authenticated and (b) include built-in models in its
 * registry/catalog output.
 *
 * Syncs all credential types: api_key, token (as api_key), and oauth.
 *
 * @deprecated Runtime auth now comes from OpenClaw auth-profiles snapshots.
 */
export async function ensurePiAuthJsonFromAuthProfiles(agentDir: string): Promise<{
  wrote: boolean;
  authPath: string;
}> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const authPath = path.join(agentDir, "auth.json");
  const providerCredentials = resolvePiCredentialMapFromStore(store);
  if (Object.keys(providerCredentials).length === 0) {
    return { wrote: false, authPath };
  }

  const existing = readAuthJson(authPath);
  let changed = false;

  for (const [provider, cred] of Object.entries(providerCredentials)) {
    if (!piCredentialsEqual(existing[provider], cred)) {
      existing[provider] = cred;
      changed = true;
    }
  }

  if (!changed) {
    return { wrote: false, authPath };
  }

  getDatastore().writeJson(authPath, existing);

  return { wrote: true, authPath };
}
