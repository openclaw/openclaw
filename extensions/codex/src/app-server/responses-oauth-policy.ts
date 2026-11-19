import type { AuthProfileCredential, AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { CodexAppServerPreparedAuth } from "./auth-types.js";
import type { CodexAppServerHomeScope } from "./config-contracts.js";

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

/** Validate grants actually handed to native; a user home keeps its own native account. */
export function resolveCodexInferenceCredential(params: {
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  homeScope: CodexAppServerHomeScope;
}): AuthProfileCredential | undefined {
  const credential = params.authProfileId
    ? params.authProfileStore.profiles[params.authProfileId]
    : undefined;
  if (
    params.homeScope !== "user" &&
    credential?.type === "oauth" &&
    credential.authFlow === "chatgpt-identity"
  ) {
    throw new Error(
      "ChatGPT subscription sharing was not granted; sign in again and enable sharing.",
    );
  }
  return credential;
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
