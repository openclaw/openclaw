import {
  fingerprintResolvedAuthProfileCredential,
  type AgentHarnessAuthBindingFingerprintParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveApiKeyForProfile, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-auth";
import {
  isCodexResponsesOAuthCredential,
  resolveCodexResponsesOAuthProfileFingerprint,
} from "./responses-oauth.js";

type CodexAppServerPreparedAuthBinding = {
  authProfileStore: AuthProfileStore;
  fingerprint: string;
};

/** Resolves one forwarded profile once so attestation and execution share exact material. */
export async function prepareCodexAppServerAuthBinding(
  params: AgentHarnessAuthBindingFingerprintParams,
): Promise<CodexAppServerPreparedAuthBinding | undefined> {
  const credential = params.authProfileStore.profiles[params.authProfileId];
  if (!credential) {
    return undefined;
  }
  if (credential.type === "oauth") {
    if (isCodexResponsesOAuthCredential(credential)) {
      const store = structuredClone(params.authProfileStore);
      const fingerprint = await resolveCodexResponsesOAuthProfileFingerprint({
        profileId: params.authProfileId,
        store,
        agentDir: params.agentDir,
        config: params.config,
      });
      return {
        fingerprint,
        authProfileStore: store,
      };
    }
    // The ChatGPT workspace can change under the same profile/email. Rotating
    // tokens for that same workspace must not invalidate a live process binding.
    const fingerprint = fingerprintResolvedAuthProfileCredential({
      profileId: params.authProfileId,
      credential: {
        ...credential,
        accountId: resolveOpenAICodexAuthIdentity(credential).accountId,
      },
      resolvedAuth: undefined,
    });
    return fingerprint
      ? { fingerprint, authProfileStore: structuredClone(params.authProfileStore) }
      : undefined;
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store: params.authProfileStore,
    profileId: params.authProfileId,
    agentDir: params.agentDir,
  });
  if (!resolved?.apiKey) {
    throw new Error(
      `Codex could not resolve auth profile "${params.authProfileId}". Repair or replace its credential or SecretRef, then retry.`,
    );
  }
  const fingerprint = fingerprintResolvedAuthProfileCredential({
    profileId: params.authProfileId,
    credential,
    resolvedAuth: {
      apiKey: resolved.apiKey,
      profileId: params.authProfileId,
      source: `profile:${params.authProfileId}`,
      mode: credential.type === "api_key" ? "api-key" : "token",
    },
  });
  if (!fingerprint) {
    throw new Error(
      `Codex could not attest auth profile "${params.authProfileId}". Re-select the OpenAI profile and retry.`,
    );
  }
  const store = structuredClone(params.authProfileStore);
  if (credential.type === "api_key") {
    const { keyRef: _keyRef, ...materialized } = credential;
    store.profiles[params.authProfileId] = { ...materialized, key: resolved.apiKey };
  } else {
    const { tokenRef: _tokenRef, ...materialized } = credential;
    store.profiles[params.authProfileId] = { ...materialized, token: resolved.apiKey };
  }
  return { fingerprint, authProfileStore: store };
}

export async function fingerprintCodexAppServerAuthBinding(
  params: AgentHarnessAuthBindingFingerprintParams,
): Promise<string | undefined> {
  return (await prepareCodexAppServerAuthBinding(params))?.fingerprint;
}
