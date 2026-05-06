import crypto from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
  type ClaudeCliCredential,
  type CodexCliCredential,
  type GeminiCliCredential,
} from "./cli-credentials.js";

type CliAuthEpochDeps = {
  readClaudeCliCredentialsCached: typeof readClaudeCliCredentialsCached;
  readCodexCliCredentialsCached: typeof readCodexCliCredentialsCached;
  readGeminiCliCredentialsCached: typeof readGeminiCliCredentialsCached;
  loadAuthProfileStoreForRuntime: typeof loadAuthProfileStoreForRuntime;
};

const defaultCliAuthEpochDeps: CliAuthEpochDeps = {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readGeminiCliCredentialsCached,
  loadAuthProfileStoreForRuntime,
};

const cliAuthEpochDeps: CliAuthEpochDeps = { ...defaultCliAuthEpochDeps };

export const CLI_AUTH_EPOCH_VERSION = 5;

export function setCliAuthEpochTestDeps(overrides: Partial<CliAuthEpochDeps>): void {
  Object.assign(cliAuthEpochDeps, overrides);
}

export function resetCliAuthEpochTestDeps(): void {
  Object.assign(cliAuthEpochDeps, defaultCliAuthEpochDeps);
}

function hashCliAuthEpochPart(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encodeUnknown(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function encodeOAuthIdentity(credential: {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
  enterpriseUrl?: string;
  projectId?: string;
  accountId?: string;
}): string {
  return JSON.stringify([
    "oauth",
    credential.provider,
    credential.clientId ?? null,
    credential.email ?? null,
    credential.enterpriseUrl ?? null,
    credential.projectId ?? null,
    credential.accountId ?? null,
  ]);
}

function encodeClaudeCredential(credential: ClaudeCliCredential): string {
  // Identity-only hashing for both OAuth and token Claude CLI credentials.
  // The Claude CLI keychain rewrite is not atomic: a token rotation can
  // briefly produce a partial read where `refreshToken` is missing, and the
  // parser falls back to a token-shaped credential. With the previous
  // token-inclusive hash, that transient race flipped the auth-epoch and
  // forced a session reset on every rotation. Routing both branches through
  // `encodeOAuthIdentity` collapses partial reads and rotations onto the
  // same provider-keyed identity hash, while a real account switch would
  // still surface as different identity fields. Fixes #74312.
  return encodeOAuthIdentity({
    type: "oauth",
    provider: credential.provider,
  });
}

function encodeCodexCredential(credential: CodexCliCredential): string {
  return encodeOAuthIdentity(credential);
}

function encodeGeminiCredential(credential: GeminiCliCredential): string {
  // Delegate to the shared OAuth-identity encoder. The Gemini CLI reader
  // lifts the Google-account identity (sub, email) off the openid id_token
  // onto the credential, so the encoder fingerprints the user through stable,
  // non-secret identity fields — matching the Claude/Codex OAuth contract.
  // When the id_token is absent (older logins, scope omitted), the encoder
  // falls back to a provider-keyed constant, the same identity-less behavior
  // the Claude CLI OAuth branch tolerates.
  return encodeOAuthIdentity(credential);
}

function encodeAuthProfileCredential(credential: AuthProfileCredential): string {
  switch (credential.type) {
    case "api_key":
      return JSON.stringify([
        "api_key",
        credential.provider,
        credential.key ?? null,
        encodeUnknown(credential.keyRef),
        credential.email ?? null,
        credential.displayName ?? null,
        encodeUnknown(credential.metadata),
      ]);
    case "token":
      // Drop `credential.token` from the hash so static-token rotation does
      // not invalidate live sessions; identity fields (provider, tokenRef,
      // email, displayName) are sufficient to detect real account changes.
      // Mirrors the OAuth identity-only fix and keeps Claude-CLI auth-profile
      // entries stable across keychain partial-read races. Refs #74312.
      return JSON.stringify([
        "token",
        credential.provider,
        encodeUnknown(credential.tokenRef),
        credential.email ?? null,
        credential.displayName ?? null,
      ]);
    case "oauth":
      return encodeOAuthIdentity(credential);
  }
  throw new Error("Unsupported auth profile credential type");
}

function getLocalCliCredentialFingerprint(provider: string): string | undefined {
  switch (provider) {
    case "claude-cli": {
      const credential = cliAuthEpochDeps.readClaudeCliCredentialsCached({
        ttlMs: 5000,
        allowKeychainPrompt: false,
      });
      // Null-safe identity fallback: when the keychain read fails entirely
      // (transient parse failure, race with claude-cli's keychain rewrite),
      // the parts-array shape would otherwise change between successful and
      // null reads, which flips the resolved auth-epoch hash even after the
      // identity-only encoder fix above. Encoding a synthetic identity-only
      // credential keeps the `local:` part shape stable across these
      // failures while a real account switch still produces a different
      // identity hash. Empirically validated by the issue reporter on
      // macOS over 5h of runtime. Refs #74312.
      return hashCliAuthEpochPart(
        encodeClaudeCredential(
          credential ?? {
            type: "oauth",
            provider: "anthropic",
            access: "",
            refresh: "",
            expires: 0,
          },
        ),
      );
    }
    case "codex-cli": {
      const credential = cliAuthEpochDeps.readCodexCliCredentialsCached({
        ttlMs: 5000,
        allowKeychainPrompt: false,
      });
      return credential ? hashCliAuthEpochPart(encodeCodexCredential(credential)) : undefined;
    }
    case "google-gemini-cli": {
      const credential = cliAuthEpochDeps.readGeminiCliCredentialsCached({
        ttlMs: 5000,
      });
      return credential ? hashCliAuthEpochPart(encodeGeminiCredential(credential)) : undefined;
    }
    default:
      return undefined;
  }
}

function getAuthProfileCredential(
  store: AuthProfileStore,
  authProfileId: string | undefined,
): AuthProfileCredential | undefined {
  if (!authProfileId) {
    return undefined;
  }
  return store.profiles[authProfileId];
}

export async function resolveCliAuthEpoch(params: {
  provider: string;
  authProfileId?: string;
  skipLocalCredential?: boolean;
}): Promise<string | undefined> {
  const provider = params.provider.trim();
  const authProfileId = normalizeOptionalString(params.authProfileId);
  const parts: string[] = [];

  if (params.skipLocalCredential !== true) {
    const localFingerprint = getLocalCliCredentialFingerprint(provider);
    if (localFingerprint) {
      parts.push(`local:${provider}:${localFingerprint}`);
    }
  }

  if (authProfileId) {
    const store = cliAuthEpochDeps.loadAuthProfileStoreForRuntime(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
    const credential = getAuthProfileCredential(store, authProfileId);
    if (credential) {
      parts.push(
        `profile:${authProfileId}:${hashCliAuthEpochPart(encodeAuthProfileCredential(credential))}`,
      );
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return hashCliAuthEpochPart(parts.join("\n"));
}
