import type { CodexAppServerClient } from "./client.js";

/** Recheck the serving account before each attempt, including reused connections. */
export async function assertCodexAppServerAuthenticated(params: {
  client: CodexAppServerClient;
  modelProvider?: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  // account/read describes the app-server's default provider, not an explicit
  // thread override. Custom providers retain their own authentication contract.
  if (params.modelProvider && params.modelProvider !== "openai") {
    return;
  }
  const options = { assertCurrent: params.assertCurrent, signal: params.signal };
  let response = await params.client.request("account/read", { refreshToken: false }, options);
  if (response.requiresOpenaiAuth && !response.account) {
    // A permanent refresh failure can hide a cached account after the operator
    // repairs its credentials. Let native auth reload that account before blocking.
    response = await params.client.request("account/read", { refreshToken: true }, options);
  }
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  // Custom providers may require no OpenAI account. The native provider owns
  // that distinction; a missing account alone is not an authentication failure.
  if (response.requiresOpenaiAuth && !response.account) {
    throw new CodexAppServerAuthenticationRequiredError();
  }
}

class CodexAppServerAuthenticationRequiredError extends Error {
  readonly status = 401;
  readonly code = "codex_auth_required";

  constructor() {
    super(
      "Codex app-server is signed out. Sign in to the account used by this app-server, then retry.",
    );
    this.name = "CodexAppServerAuthenticationRequiredError";
  }
}
