/** Client-scoped Codex auth and account observers. */
import { refreshCodexAppServerAuthTokens } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonValue } from "./protocol.js";
import { mergeCodexRateLimitsUpdate } from "./rate-limit-cache.js";
import type { CodexAppServerAuthProfileLookup } from "./session-binding.js";

type ClientRuntimeContext = Omit<CodexAppServerAuthProfileLookup, "agentDir"> & {
  agentDir: string;
};

type ClientRuntime = {
  context: ClientRuntimeContext;
};

const configuredClients = new WeakMap<CodexAppServerClient, ClientRuntime>();

/** Installs one auth-refresh handler and one rate-limit observer per physical client. */
export function ensureCodexAppServerClientRuntime(
  client: CodexAppServerClient,
  context: ClientRuntimeContext,
): void {
  const existing = configuredClients.get(client);
  if (existing) {
    // Shared-client keys already isolate agent/auth identity. Keep config fresh
    // without installing another physical-client handler set.
    existing.context = context;
    return;
  }
  const runtime: ClientRuntime = { context };
  configuredClients.set(client, runtime);
  client.addRequestHandler(async (request) => {
    if (request.method !== "account/chatgptAuthTokens/refresh") {
      return undefined;
    }
    return (await refreshCodexAppServerAuthTokens({
      agentDir: runtime.context.agentDir,
      authProfileId: runtime.context.authProfileId,
      ...(runtime.context.authProfileStore
        ? { authProfileStore: runtime.context.authProfileStore }
        : {}),
      config: runtime.context.config,
    })) as unknown as JsonValue;
  });
  client.addNotificationHandler((notification) => {
    if (notification.method === "account/rateLimits/updated") {
      mergeCodexRateLimitsUpdate(client, notification.params);
    }
  });
}
