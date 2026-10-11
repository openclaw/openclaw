import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import { fingerprintTokenAuthProfileCacheKey } from "./auth-cache-key.js";
import type { CodexAppServerAuthRuntimeContext } from "./auth-profile.js";
import type { CodexAppServerAuthHandoff } from "./auth-types.js";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";
import { withTimeout } from "./timeout.js";

/** Return a deterministic error before Codex cancels its ten-second external-auth request. */
const CODEX_EXTERNAL_AUTH_REFRESH_TIMEOUT_MS = 9_000;

export type CodexAppServerClientAuthState = {
  context: CodexAppServerAuthRuntimeContext;
  authHandoff?: CodexAppServerAuthHandoff;
  closed: boolean;
};

/** The physical client's runtime owns this mutable auth view for its entire lifetime. */
export function installCodexAppServerAuthRefresh(
  client: CodexAppServerClient,
  runtime: CodexAppServerClientAuthState,
): void {
  client.addRequestHandler(async (request) => {
    if (request.method !== "account/chatgptAuthTokens/refresh") {
      return undefined;
    }
    if (runtime.context.authMode === "prepared-api-key") {
      throw new Error("ChatGPT token refresh is unavailable for prepared Codex API-key auth.");
    }
    if (!runtime.context.agentDir) {
      throw new Error("ChatGPT token refresh requires an OpenClaw-owned auth profile.");
    }
    const previousAccountId =
      isJsonObject(request.params) && typeof request.params.previousAccountId === "string"
        ? request.params.previousAccountId.trim() || undefined
        : undefined;
    const authHandoff = runtime.authHandoff;
    try {
      const tokens = await withTimeout(
        refreshCodexAppServerAuthTokens({
          agentDir: runtime.context.agentDir,
          authProfileId: runtime.context.authProfileId,
          ...(authHandoff ? { authHandoff } : {}),
          ...(previousAccountId ? { previousAccountId } : {}),
          ...(runtime.context.authProfileStore
            ? { authProfileStore: runtime.context.authProfileStore }
            : {}),
          config: runtime.context.config,
        }),
        CODEX_EXTERNAL_AUTH_REFRESH_TIMEOUT_MS,
        "Codex app-server ChatGPT token refresh timed out before its external-auth deadline. Retry the request; if it persists, sign in again with OpenClaw.",
      );
      if (runtime.closed) {
        throw new Error("Codex app-server client closed during ChatGPT token refresh.");
      }
      runtime.authHandoff = {
        accessFingerprint: fingerprintTokenAuthProfileCacheKey(tokens.accessToken),
        chatgptAccountId: tokens.chatgptAccountId,
      };
      return { ...tokens };
    } catch (error) {
      // Failed refresh leaves Codex holding its old account. Detach the cached
      // process before another acquisition; existing leases can finish safely.
      runtime.context.onAuthRefreshFailure?.();
      throw error;
    }
  });
}
