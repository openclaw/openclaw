import { createHash } from "node:crypto";
import {
  findPersistedAuthProfileCredential,
  isPendingOAuthRefreshFence,
  isSameOAuthRefreshGeneration,
  resolveApiKeyForProfile,
  type AuthProfileCredential,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { decodeOpenAICodexJwtPayload } from "openclaw/plugin-sdk/provider-auth";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";

// A distinct native provider selects HTTP and local summarization. OpenClaw's
// public provider remains `openai`; this id belongs only to its private process.
export const CODEX_RESPONSES_OAUTH_PROVIDER = "openclaw_token_sharing";

export function isCodexResponsesOAuthRun(params: {
  runtimePlan?: { auth: { selectedAuthMode?: string; selectedAuthFlow?: string } };
}): boolean {
  return (
    params.runtimePlan?.auth.selectedAuthMode === "oauth" &&
    params.runtimePlan.auth.selectedAuthFlow === "chatgpt-token-sharing"
  );
}

export function isCodexResponsesOAuthCredential(credential: AuthProfileCredential | undefined) {
  return (
    credential?.type === "oauth" &&
    credential.provider === "openai" &&
    credential.authFlow === "chatgpt-token-sharing"
  );
}

export function isCodexResponsesOAuth(prepared: CodexAppServerPreparedAuth | undefined): boolean {
  return prepared?.kind === "profile" && prepared.snapshot?.inferenceAuth === "host-oauth";
}

/** The OAuth owner verified this ID token. Decoding here compares identity, never proves it. */
function fingerprintCodexResponsesOAuth(credential: AuthProfileCredential | undefined) {
  if (!isCodexResponsesOAuthCredential(credential) || credential?.type !== "oauth") {
    throw new Error("ChatGPT subscription sharing is unavailable; sign in with OpenClaw again.");
  }
  const subject = credential.idToken && decodeOpenAICodexJwtPayload(credential.idToken)?.sub;
  if (!credential.issuer || !credential.clientId || typeof subject !== "string" || !subject) {
    throw new Error("ChatGPT subscription sharing identity is missing; sign in again.");
  }
  return createHash("sha256")
    .update(JSON.stringify([credential.issuer, credential.clientId, subject, credential.authFlow]))
    .digest("hex");
}

export type CodexResponsesOAuth = {
  resolve: (forceRefresh: boolean) => Promise<{ token: string; assertCurrent: () => void }>;
};

export async function resolveCodexResponsesOAuthProfileFingerprint(params: {
  profileId: string;
  store: AuthProfileStore;
  agentDir?: string;
  config?: Parameters<typeof resolveApiKeyForProfile>[0]["cfg"];
}): Promise<string> {
  const credential = params.store.profiles[params.profileId];
  if (credential?.type === "oauth" && isPendingOAuthRefreshFence(credential)) {
    // A cold client can observe an in-progress durable refresh. Its selected
    // profile owner must settle before we can bind the verified subject.
    const resolved = await resolveApiKeyForProfile({
      cfg: params.config,
      store: params.store,
      profileId: params.profileId,
      agentDir: params.agentDir,
      allowProfileFallback: false,
    });
    if (!resolved?.credential || resolved.profileId !== params.profileId) {
      throw new Error("ChatGPT subscription sharing could not settle its refresh; sign in again.");
    }
    const fingerprint = fingerprintCodexResponsesOAuth(resolved.credential);
    params.store.profiles[params.profileId] = resolved.credential;
    return fingerprint;
  }
  if (!credential) {
    throw new Error("ChatGPT subscription sharing profile is unavailable; sign in again.");
  }
  return fingerprintCodexResponsesOAuth(credential);
}

/** Keep OAuth refresh and persisted grant ownership in OpenClaw, outside native Codex auth. */
export function createCodexResponsesOAuth(params: {
  profileId: string;
  store: AuthProfileStore;
  fingerprint: string;
  agentDir?: string;
  config?: Parameters<typeof resolveApiKeyForProfile>[0]["cfg"];
}): CodexResponsesOAuth {
  const persisted =
    Boolean(findPersistedAuthProfileCredential(params)) ||
    params.store.runtimePersistedProfileIds?.includes(params.profileId) === true;
  const readCredential = () =>
    persisted
      ? findPersistedAuthProfileCredential(params)
      : params.store.profiles[params.profileId];
  const validate = (credential: AuthProfileCredential | undefined) => {
    if (fingerprintCodexResponsesOAuth(credential) !== params.fingerprint) {
      throw new Error("ChatGPT subscription sharing identity changed; reconnect before retrying.");
    }
  };
  let lastCredential = params.store.profiles[params.profileId];
  validate(lastCredential);
  const validateCurrent = (
    credential: AuthProfileCredential | undefined,
    reference: AuthProfileCredential | undefined,
  ) => {
    // The durable refresh owner removes the ID token while it holds the claim.
    // Only its exact previously validated token generation may join that refresh.
    if (
      credential?.type === "oauth" &&
      reference?.type === "oauth" &&
      isPendingOAuthRefreshFence(credential) &&
      credential.authFlow === reference.authFlow &&
      credential.issuer === reference.issuer &&
      credential.clientId === reference.clientId &&
      isSameOAuthRefreshGeneration({
        profileId: params.profileId,
        left: credential,
        right: reference,
      })
    ) {
      return;
    }
    validate(credential);
  };
  return {
    async resolve(forceRefresh) {
      const credential = readCredential();
      validateCurrent(credential, lastCredential);
      const resolved = await resolveApiKeyForProfile({
        cfg: params.config,
        agentDir: params.agentDir,
        profileId: params.profileId,
        store: persisted
          ? {
              ...params.store,
              profiles: { ...params.store.profiles, [params.profileId]: credential! },
            }
          : params.store,
        forceRefresh,
        allowProfileFallback: false,
        validateOAuthCredential: validate,
      });
      if (!resolved?.apiKey || resolved.profileId !== params.profileId) {
        throw new Error("ChatGPT subscription sharing could not refresh; sign in again.");
      }
      const resolvedCredential = resolved.credential;
      validate(resolvedCredential);
      lastCredential = resolvedCredential;
      const assertCurrent = () => validateCurrent(readCredential(), resolvedCredential);
      assertCurrent();
      return { token: resolved.apiKey, assertCurrent };
    },
  };
}
