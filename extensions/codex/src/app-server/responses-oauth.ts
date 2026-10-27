import type { AuthProfileCredential } from "openclaw/plugin-sdk/agent-runtime";
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

export type CodexResponsesOAuth = {
  resolve: (forceRefresh: boolean) => Promise<{ token: string; assertCurrent: () => void }>;
};
