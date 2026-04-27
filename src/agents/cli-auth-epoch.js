import crypto from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store.js";
import { readClaudeCliCredentialsCached, readCodexCliCredentialsCached, readGeminiCliCredentialsCached, } from "./cli-credentials.js";
const defaultCliAuthEpochDeps = {
    readClaudeCliCredentialsCached,
    readCodexCliCredentialsCached,
    readGeminiCliCredentialsCached,
    loadAuthProfileStoreForRuntime,
};
const cliAuthEpochDeps = { ...defaultCliAuthEpochDeps };
export const CLI_AUTH_EPOCH_VERSION = 4;
export function setCliAuthEpochTestDeps(overrides) {
    Object.assign(cliAuthEpochDeps, overrides);
}
export function resetCliAuthEpochTestDeps() {
    Object.assign(cliAuthEpochDeps, defaultCliAuthEpochDeps);
}
function hashCliAuthEpochPart(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}
function encodeUnknown(value) {
    return JSON.stringify(value ?? null);
}
function encodeOAuthIdentity(credential) {
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
function encodeClaudeCredential(credential) {
    if (credential.type === "oauth") {
        return encodeOAuthIdentity(credential);
    }
    return JSON.stringify(["token", credential.provider, credential.token]);
}
function encodeCodexCredential(credential) {
    return encodeOAuthIdentity(credential);
}
function encodeGeminiCredential(credential) {
    // Delegate to the shared OAuth-identity encoder. The Gemini CLI reader
    // lifts the Google-account identity (sub, email) off the openid id_token
    // onto the credential, so the encoder fingerprints the user through stable,
    // non-secret identity fields — matching the Claude/Codex OAuth contract.
    // When the id_token is absent (older logins, scope omitted), the encoder
    // falls back to a provider-keyed constant, the same identity-less behavior
    // the Claude CLI OAuth branch tolerates.
    return encodeOAuthIdentity(credential);
}
function encodeAuthProfileCredential(credential) {
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
            return JSON.stringify([
                "token",
                credential.provider,
                credential.token ?? null,
                encodeUnknown(credential.tokenRef),
                credential.email ?? null,
                credential.displayName ?? null,
            ]);
        case "oauth":
            return encodeOAuthIdentity(credential);
    }
    throw new Error("Unsupported auth profile credential type");
}
function getLocalCliCredentialFingerprint(provider) {
    switch (provider) {
        case "claude-cli": {
            const credential = cliAuthEpochDeps.readClaudeCliCredentialsCached({
                ttlMs: 5000,
                allowKeychainPrompt: false,
            });
            return credential ? hashCliAuthEpochPart(encodeClaudeCredential(credential)) : undefined;
        }
        case "codex-cli": {
            const credential = cliAuthEpochDeps.readCodexCliCredentialsCached({
                ttlMs: 5000,
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
function getAuthProfileCredential(store, authProfileId) {
    if (!authProfileId) {
        return undefined;
    }
    return store.profiles[authProfileId];
}
export async function resolveCliAuthEpoch(params) {
    const provider = params.provider.trim();
    const authProfileId = normalizeOptionalString(params.authProfileId);
    const parts = [];
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
            parts.push(`profile:${authProfileId}:${hashCliAuthEpochPart(encodeAuthProfileCredential(credential))}`);
        }
    }
    if (parts.length === 0) {
        return undefined;
    }
    return hashCliAuthEpochPart(parts.join("\n"));
}
