import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { fingerprintCodexAppServerAuthBinding } from "./app-server/auth-binding.js";
import { resolveCodexAppServerAuthAccountCacheKey } from "./app-server/auth-bridge.js";
import {
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./app-server/auth-cache-key.js";
import { resolveCodexAppServerAuthProfileStore } from "./app-server/auth-profile.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { buildCodexPluginAppCacheKey } from "./app-server/plugin-app-cache-key.js";
import { withCodexAppServerJsonClient } from "./app-server/request.js";
import type { CodexCommandDeps } from "./command-handler-deps.js";
import { resolveCommandAppServerContext, resolveControlTarget } from "./command-handler-scope.js";
import type { CodexPluginsConfigBlock } from "./command-plugin-config.js";
import { prepareCodexControlSessionAuth } from "./command-rpc.js";
import { readCodexConversationBindingData } from "./conversation-binding-data.js";

const SCOPE_CHANGED_MESSAGE =
  "Codex account, conversation, or plugin policy changed. Run the command again.";

/** One account and physical connection for plugin inspection or hosted app refresh. */
export type CodexPluginCommandContext = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  workspaceDir: string;
  agentId: string;
  profileId?: string;
  threadId?: string;
  appCacheKey: string;
  current: CodexPluginsConfigBlock;
  validateCurrent: () => Promise<void>;
};

export async function withCodexPluginCommandContext<T>(
  params: { deps: CodexCommandDeps; ctx: PluginCommandContext; pluginConfig: unknown },
  run: (context: CodexPluginCommandContext) => Promise<T>,
): Promise<T> {
  const { deps, ctx, pluginConfig } = params;
  const current = (await deps.codexPluginsManagementIo?.readConfig()) ?? {};
  const initialPolicy = JSON.stringify(current);
  const { scope, target, binding } = await resolveCommandAppServerContext(deps, ctx, pluginConfig);
  const conversation = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
  const workspaceDir =
    binding?.cwd ||
    (conversation?.kind === "codex-app-server-session" ? conversation.workspaceDir : undefined) ||
    resolveAgentWorkspaceDir(ctx.config, scope.agentId);
  const configuredRuntime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  const appServer = scope.startOptions
    ? { ...configuredRuntime, start: scope.startOptions }
    : configuredRuntime;
  const auth = await prepareCodexControlSessionAuth(
    { ...scope, config: ctx.config },
    appServer.start,
  );
  const preparedAuth =
    "preparedAuth" in auth.clientOptions ? auth.clientOptions.preparedAuth : undefined;
  const usesNativeAuth = scope.authProfileId === null || appServer.start.homeScope === "user";
  const profileId = usesNativeAuth ? undefined : auth.authProfileId;
  const readAuthBinding = () =>
    profileId
      ? fingerprintCodexAppServerAuthBinding({
          authProfileId: profileId,
          authProfileStore: resolveCodexAppServerAuthProfileStore({
            authProfileId: profileId,
            agentDir: scope.agentDir,
            config: ctx.config,
          }),
          agentDir: scope.agentDir,
          config: ctx.config,
        })
      : Promise.resolve(undefined);
  // Compare the prepared principal binding, not cache keys with email/profile fallbacks.
  // A profile can change accounts while preparation awaits, before a client is leased.
  const authBinding =
    "authBindingFingerprint" in auth.clientOptions
      ? auth.clientOptions.authBindingFingerprint
      : await readAuthBinding();
  const accountId = usesNativeAuth
    ? undefined
    : preparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(preparedAuth.apiKey)
      : preparedAuth?.kind === "profile"
        ? preparedAuth.snapshot.secretFreeCacheKey
        : await resolveCodexAppServerAuthAccountCacheKey({
            authProfileId: profileId,
            agentDir: scope.agentDir,
            config: ctx.config,
          });
  if ((await readAuthBinding()) !== authBinding) {
    throw new Error(SCOPE_CHANGED_MESSAGE);
  }
  return await withCodexAppServerJsonClient(
    {
      startOptions: appServer.start,
      pluginConfig,
      agentDir: scope.agentDir,
      config: ctx.config,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
      timeoutMs: appServer.requestTimeoutMs,
      timeoutMessage: "Codex plugin request timed out. Check the Codex connection and retry.",
      assertCurrent: scope.assertCurrent,
      ...auth.clientOptions,
    },
    async (request, client, requestScope) => {
      const assertCurrent = () => {
        requestScope.assertCurrent();
        if (client.getCloseError()) {
          throw new Error(SCOPE_CHANGED_MESSAGE);
        }
      };
      const validateCurrent = async () => {
        assertCurrent();
        const currentTarget = await resolveControlTarget(ctx);
        const currentConversation = readCodexConversationBindingData(
          await ctx.getCurrentConversationBinding(),
        );
        const currentPolicy = JSON.stringify(
          (await deps.codexPluginsManagementIo?.readConfig()) ?? {},
        );
        const currentAuthBinding = await readAuthBinding();
        // Reads can outlive cancellation; never publish after the request scope ends.
        assertCurrent();
        if (
          !isDeepStrictEqual(currentTarget, target) ||
          !isDeepStrictEqual(currentConversation, conversation) ||
          currentPolicy !== initialPolicy ||
          currentAuthBinding !== authBinding
        ) {
          throw new Error(SCOPE_CHANGED_MESSAGE);
        }
      };
      // Codex serializes account/read after login's delayed account/updated.
      // Drain startup before subscribing so the prepared login is not revoked.
      try {
        await request({
          method: "account/read",
          requestParams: { refreshToken: false },
          assertCurrent,
        });
      } catch {
        requestScope.assertCurrent();
        throw new Error(
          "Codex account startup could not be confirmed. Check /codex account and retry.",
        );
      }
      const unsubscribe = client.addNotificationHandler((notification) => {
        if (notification.method === "account/updated") {
          requestScope.abort(new Error(SCOPE_CHANGED_MESSAGE));
        }
      });
      try {
        await validateCurrent();
        const result = await run({
          request: async <TResponse>(
            method: string,
            requestParams?: unknown,
          ): Promise<TResponse> => {
            await validateCurrent();
            const response = await request<TResponse>({ method, requestParams, assertCurrent });
            await validateCurrent();
            return response;
          },
          workspaceDir,
          agentId: scope.agentId,
          current,
          ...(profileId ? { profileId } : {}),
          // Persisted thread ids alone cannot attest a different physical client.
          ...(binding?.clientId === client.getInstanceId() ? { threadId: binding.threadId } : {}),
          appCacheKey: buildCodexPluginAppCacheKey({
            appServer,
            agentDir: scope.agentDir,
            authProfileId: profileId,
            accountId,
            envApiKeyFingerprint:
              usesNativeAuth || preparedAuth || profileId
                ? undefined
                : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: appServer.start }),
            appServerVersion: client.getServerVersion(),
            runtimeIdentity: client.getRuntimeIdentity(),
          }),
          validateCurrent,
        });
        await validateCurrent();
        return result;
      } finally {
        unsubscribe();
      }
    },
  );
}
