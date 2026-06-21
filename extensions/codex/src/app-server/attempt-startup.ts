/**
 * Startup orchestration for Codex app-server attempts, including shared-client
 * leasing, plugin thread config, sandbox execution environment, and thread
 * lifecycle binding.
 */
import {
  embeddedAgentLog,
  formatErrorMessage,
  type CodexBundleMcpThreadConfig,
  type EmbeddedRunAttemptParams,
  type resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  isCodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { buildCodexPluginThreadConfigEligibilityLogData } from "./attempt-diagnostics.js";
import { withCodexStartupTimeout } from "./attempt-timeouts.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { isCodexAppServerConnectionClosedError, type CodexAppServerClient } from "./client.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import {
  resolveCodexPluginsPolicy,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type CodexPluginConfig,
  type CodexComputerUseConfig,
} from "./config.js";
import {
  disableCodexPluginThreadConfig,
  resolveCodexAppServerExecutionCwd,
  resolveCodexExternalSandboxPolicyForOpenClawSandbox,
  resolveCodexSandboxEnvironmentSelection,
  shouldRequireCodexSandboxExecServerEnvironment,
} from "./dynamic-tool-build.js";
import {
  buildCodexAppServerRuntimeFingerprint,
  buildCodexPluginAppCacheKey,
} from "./plugin-app-cache-key.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  mergeCodexThreadConfigs,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type {
  CodexDynamicToolSpec,
  CodexSandboxPolicy,
  CodexTurnEnvironmentParams,
  JsonObject,
} from "./protocol.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  leaseSharedCodexAppServerClient,
  type CodexAppServerClientLease,
  type CodexAppServerClientLeaseFactory,
} from "./shared-client.js";
import type { CodexAppServerStartupTokenGuard } from "./startup-binding.js";
import {
  startOrResumeThread,
  type CodexAppServerThreadLifecycleBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";
import {
  getCodexAppServerTurnRouter,
  type CodexAppServerTurnRouter,
  type CodexThreadRouteReservation,
} from "./turn-router.js";

const CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS = 3;

type CodexSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/** Resources and bindings returned after a Codex attempt thread starts. */
export type StartCodexAttemptThreadResult = {
  turnRouter: CodexAppServerTurnRouter;
  turnRoute: CodexThreadRouteReservation;
  thread: CodexAppServerThreadLifecycleBinding;
  sandboxEnvironment: CodexSandboxExecEnvironment | undefined;
  environmentSelection: CodexTurnEnvironmentParams[] | undefined;
  executionCwd: string;
  sandboxPolicy: CodexSandboxPolicy | undefined;
  clientLease: CodexAppServerClientLease;
  mcpElicitationDelegationRequired: boolean;
  restartContextEngineCodexThread: () => Promise<CodexAppServerThreadLifecycleBinding>;
};

/**
 * Starts or resumes the Codex app-server thread and returns the resources the
 * run loop must later release.
 */
export async function startCodexAttemptThread(params: {
  bindingStore: CodexAppServerBindingStore;
  clientLeaseFactory?: CodexAppServerClientLeaseFactory;
  appServer: CodexAppServerRuntimeOptions;
  pluginConfig: CodexPluginConfig;
  computerUseConfig: CodexComputerUseConfig;
  startupAuthProfileId: string | undefined;
  startupAuthAccountCacheKey: string | undefined;
  startupEnvApiKeyCacheKey: string | undefined;
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  buildAttemptParams: () => EmbeddedRunAttemptParams;
  sessionAgentId: string;
  effectiveWorkspace: string;
  effectiveCwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  persistentWebSearchAllowed?: boolean;
  webSearchAllowed: boolean;
  developerInstructions: string | undefined;
  finalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["finalConfigPatch"];
  buildFinalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["buildFinalConfigPatch"];
  nativeHookRelayGeneration?: string;
  bundleMcpThreadConfig: CodexBundleMcpThreadConfig;
  nativeToolSurfaceEnabled: boolean;
  nativeProviderWebSearchSupport: CodexNativeWebSearchSupport;
  sandboxExecServerEnabled: boolean;
  sandbox: CodexSandboxContext;
  contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  expectedResumeThreadId?: string;
  startupTokenGuard: CodexAppServerStartupTokenGuard;
  startupTimeoutMs: number;
  signal: AbortSignal;
  onStartupTimeout: () => void | Promise<void>;
  onThreadReserved?: (client: CodexAppServerClient, threadId: string) => () => void;
}): Promise<StartCodexAttemptThreadResult> {
  let mcpElicitationDelegationRequired = false;
  let sharedClientLease: CodexAppServerClientLease | undefined;
  let releaseStartupResourcesOnTimeout: (() => Promise<void>) | undefined;
  let startupAbandoned = false;
  const startupAbandonController = new AbortController();
  const abandonStartupAcquire = () => startupAbandonController.abort();
  const abandonStartupClient = async () => {
    const lease = sharedClientLease;
    sharedClientLease = undefined;
    if (lease) {
      await lease.abandon();
    }
  };
  params.signal.addEventListener("abort", abandonStartupAcquire, { once: true });
  try {
    const startupResult = await withCodexStartupTimeout({
      timeoutMs: params.startupTimeoutMs,
      signal: params.signal,
      onTimeout: async () => {
        startupAbandoned = true;
        startupAbandonController.abort();
        await params.onStartupTimeout();
        await releaseStartupResourcesOnTimeout?.();
        await abandonStartupClient();
      },
      operation: async () => {
        const threadConfig = mergeCodexThreadConfigs(
          params.bundleMcpThreadConfig?.configPatch as JsonObject | undefined,
        );
        const nativeToolSurfaceRestricted = !params.nativeToolSurfaceEnabled;
        const pluginThreadConfigRequired =
          nativeToolSurfaceRestricted || shouldBuildCodexPluginThreadConfig(params.pluginConfig);
        // Restricted runs still need a plugin thread config so thread/start
        // carries the explicit apps._default denial patch without app/list.
        const pluginThreadConfigPluginConfig = params.nativeToolSurfaceEnabled
          ? params.pluginConfig
          : disableCodexPluginThreadConfig(params.pluginConfig);
        const resolvedPluginPolicy = pluginThreadConfigRequired
          ? resolveCodexPluginsPolicy(pluginThreadConfigPluginConfig)
          : undefined;
        const computerUseMcpElicitationDelegationRequired =
          params.computerUseConfig.enabled === true;
        mcpElicitationDelegationRequired =
          resolvedPluginPolicy?.enabled === true || computerUseMcpElicitationDelegationRequired;
        const enabledPluginConfigKeys = resolvedPluginPolicy
          ? resolvedPluginPolicy.pluginPolicies
              .filter((plugin) => plugin.enabled)
              .map((plugin) => plugin.configKey)
              .toSorted()
          : undefined;
        const pluginAppServer = mcpElicitationDelegationRequired
          ? {
              ...params.appServer,
              approvalPolicy: withMcpElicitationsApprovalPolicy(params.appServer.approvalPolicy),
            }
          : params.appServer;

        let attemptedClientAbandoned = false;
        const startupAttempt = async () => {
          let startupClientLease: CodexAppServerClientLease | undefined;
          let clientWorkStarted = false;
          attemptedClientAbandoned = false;
          try {
            startupClientLease = await (
              params.clientLeaseFactory ?? leaseSharedCodexAppServerClient
            )({
              startOptions: params.appServer.start,
              authProfileId: params.startupAuthProfileId,
              agentDir: params.agentDir,
              config: params.config,
              preparedAuth: {
                profileId: params.startupAuthProfileId,
                cacheKey: params.startupAuthAccountCacheKey ?? params.startupEnvApiKeyCacheKey,
              },
              abandonSignal: startupAbandonController.signal,
            });
            const activeStartupLease = startupClientLease;
            const activeStartupClient = activeStartupLease.client;
            sharedClientLease = startupClientLease;
            if (startupAbandoned) {
              throw new Error("codex app-server startup timed out");
            }
            if (startupAbandonController.signal.aborted) {
              throw new Error("codex app-server startup aborted");
            }
            clientWorkStarted = true;
            ensureCodexAppServerClientRuntime(activeStartupClient, {
              agentDir: params.agentDir,
              authProfileId: params.startupAuthProfileId,
              config: params.config,
            });
            const turnRouter = getCodexAppServerTurnRouter(activeStartupClient);
            await ensureCodexComputerUse({
              client: activeStartupClient,
              pluginConfig: params.pluginConfig,
              timeoutMs: params.appServer.requestTimeoutMs,
              signal: startupAbandonController.signal,
            });
            const startupRuntimeIdentity = activeStartupClient.getRuntimeIdentity();
            const pluginAppCacheKey = buildCodexPluginAppCacheKey({
              appServer: params.appServer,
              agentDir: params.agentDir,
              authProfileId: params.startupAuthProfileId,
              accountId: params.startupAuthAccountCacheKey,
              envApiKeyFingerprint: params.startupEnvApiKeyCacheKey,
              appServerVersion: activeStartupClient.getServerVersion(),
              runtimeIdentity: startupRuntimeIdentity,
            });
            const appServerRuntimeFingerprint = buildCodexAppServerRuntimeFingerprint({
              appServer: params.appServer,
              appServerVersion: activeStartupClient.getServerVersion(),
              runtimeIdentity: startupRuntimeIdentity,
            });
            const pluginThreadConfigInputFingerprint = pluginThreadConfigRequired
              ? buildCodexPluginThreadConfigInputFingerprint({
                  pluginConfig: pluginThreadConfigPluginConfig,
                  appCacheKey: pluginAppCacheKey,
                })
              : undefined;
            const attemptParams = params.buildAttemptParams();
            embeddedAgentLog.debug(
              "codex plugin thread config eligibility",
              buildCodexPluginThreadConfigEligibilityLogData({
                sessionId: attemptParams.sessionId,
                sessionKey: attemptParams.sessionKey ?? "",
                pluginThreadConfigRequired,
                resolvedPluginPolicy,
                enabledPluginConfigKeys,
                pluginAppCacheKey,
                startupAuthProfileId: params.startupAuthProfileId,
                appServer: params.appServer,
              }),
            );
            let startupSandboxEnvironment: CodexSandboxExecEnvironment | undefined;
            let startupSandboxEnvironmentAcquired = false;
            const releaseStartupSandboxEnvironment = async () => {
              if (startupSandboxEnvironmentAcquired) {
                startupSandboxEnvironmentAcquired = false;
                await releaseCodexSandboxExecServerEnvironment(params.sandbox);
              }
            };
            releaseStartupResourcesOnTimeout = releaseStartupSandboxEnvironment;
            try {
              startupSandboxEnvironment = shouldRequireCodexSandboxExecServerEnvironment({
                sandbox: params.sandbox,
                nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
                sandboxExecServerEnabled: params.sandboxExecServerEnabled,
              })
                ? await ensureCodexSandboxExecServerEnvironment({
                    client: activeStartupClient,
                    sandbox: params.sandbox ?? null,
                    appServerStartOptions: params.appServer.start,
                    timeoutMs: params.appServer.requestTimeoutMs,
                    signal: startupAbandonController.signal,
                  })
                : undefined;
              startupSandboxEnvironmentAcquired = Boolean(startupSandboxEnvironment);
              if (startupAbandonController.signal.aborted) {
                throw new Error("codex app-server startup aborted");
              }
              if (
                params.sandbox?.enabled &&
                params.nativeToolSurfaceEnabled &&
                params.sandboxExecServerEnabled &&
                !startupSandboxEnvironment
              ) {
                throw new Error(
                  "Codex app-server did not register an OpenClaw sandbox exec-server environment.",
                );
              }
            } catch (error) {
              await releaseStartupSandboxEnvironment();
              throw error;
            }
            const startupEnvironmentSelection = resolveCodexSandboxEnvironmentSelection(
              startupSandboxEnvironment,
              params.nativeToolSurfaceEnabled,
            );
            const startupExecutionCwd = resolveCodexAppServerExecutionCwd({
              effectiveCwd: params.effectiveCwd,
              localWorkspaceRoot: params.effectiveWorkspace,
              environment: startupSandboxEnvironment,
              nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
              remoteWorkspaceRoot: params.appServer.remoteWorkspaceRoot,
            });
            const startupSandboxPolicy = startupSandboxEnvironment
              ? resolveCodexExternalSandboxPolicyForOpenClawSandbox(params.sandbox)
              : undefined;
            let startupReservation:
              | { route: CodexThreadRouteReservation; release: () => void }
              | undefined;
            const reserveStartupThread = (threadId: string) => {
              if (startupReservation) {
                if (startupReservation.route.threadId !== threadId) {
                  throw new Error(
                    `codex app-server reserved ${startupReservation.route.threadId} but started ${threadId}`,
                  );
                }
                return { release: startupReservation.release };
              }
              const route = turnRouter.reserveThread({
                threadId,
                releaseOn: params.signal,
              });
              let releaseIntegration: (() => void) | undefined;
              try {
                releaseIntegration = params.onThreadReserved?.(activeStartupClient, threadId);
              } catch (error) {
                route.release();
                throw error;
              }
              let released = false;
              const release = () => {
                if (released) {
                  return;
                }
                released = true;
                if (startupReservation?.route === route) {
                  startupReservation = undefined;
                }
                route.release();
                releaseIntegration?.();
              };
              startupReservation = { route, release };
              return { release };
            };
            const releaseStartupResources = async () => {
              startupReservation?.release();
              await releaseStartupSandboxEnvironment();
            };
            releaseStartupResourcesOnTimeout = releaseStartupResources;
            const buildThreadLifecycleParams = (
              signal: AbortSignal,
              options: { freshStartOnly?: boolean } = {},
            ) =>
              ({
                client: activeStartupClient,
                abandonClient: activeStartupLease.abandon,
                bindingStore: params.bindingStore,
                params: params.buildAttemptParams(),
                agentId: params.sessionAgentId,
                cwd: startupExecutionCwd,
                dynamicTools: params.dynamicTools,
                persistentWebSearchAllowed: params.persistentWebSearchAllowed,
                webSearchAllowed: params.webSearchAllowed,
                appServer: pluginAppServer,
                developerInstructions: params.developerInstructions,
                config: threadConfig,
                finalConfigPatch: params.finalConfigPatch,
                buildFinalConfigPatch: params.buildFinalConfigPatch,
                nativeHookRelayGeneration: params.nativeHookRelayGeneration,
                nativeCodeModeEnabled: params.nativeToolSurfaceEnabled,
                nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
                nativeCodeModeOnlyEnabled: params.appServer.codeModeOnly,
                userMcpServersEnabled: params.nativeToolSurfaceEnabled,
                mcpServersFingerprint: params.bundleMcpThreadConfig.fingerprint,
                mcpServersFingerprintEvaluated: params.bundleMcpThreadConfig.evaluated,
                environmentSelection: startupEnvironmentSelection,
                appServerRuntimeFingerprint,
                contextEngineProjection: params.contextEngineProjection,
                freshStartOnly: options.freshStartOnly,
                expectedResumeThreadId: options.freshStartOnly
                  ? undefined
                  : params.expectedResumeThreadId,
                signal,
                reserveResumeThread: options.freshStartOnly ? undefined : reserveStartupThread,
                startupTokenGuard: params.startupTokenGuard,
                pluginThreadConfig: pluginThreadConfigRequired
                  ? {
                      enabled: true,
                      inputFingerprint: pluginThreadConfigInputFingerprint,
                      enabledPluginConfigKeys,
                      build: () =>
                        buildCodexPluginThreadConfig({
                          pluginConfig: pluginThreadConfigPluginConfig,
                          request: (method, requestParams) =>
                            activeStartupClient.request(method, requestParams, {
                              timeoutMs: params.appServer.requestTimeoutMs,
                              signal,
                            }),
                          appCache: defaultCodexAppInventoryCache,
                          appCacheKey: pluginAppCacheKey,
                        }),
                    }
                  : undefined,
              }) satisfies Parameters<typeof startOrResumeThread>[0];
            try {
              const startupThread = await startOrResumeThread(
                buildThreadLifecycleParams(startupAbandonController.signal),
              );
              try {
                reserveStartupThread(startupThread.threadId);
              } catch (error) {
                const unsubscribed = await unsubscribeCodexThreadBestEffort(activeStartupClient, {
                  threadId: startupThread.threadId,
                  timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
                });
                if (!unsubscribed) {
                  throw new CodexAppServerUnsafeSubscriptionError(
                    "Codex startup subscription cleanup failed",
                    { cause: error },
                  );
                }
                throw error;
              }
              if (startupAbandonController.signal.aborted) {
                throw new Error("codex app-server startup aborted");
              }
              if (!startupReservation) {
                throw new Error("codex app-server startup did not reserve its thread route");
              }
              startupSandboxEnvironmentAcquired = false;
              return {
                turnRouter,
                turnRoute: startupReservation.route,
                thread: startupThread,
                sandboxEnvironment: startupSandboxEnvironment,
                environmentSelection: startupEnvironmentSelection,
                executionCwd: startupExecutionCwd,
                sandboxPolicy: startupSandboxPolicy,
                restartContextEngineCodexThread: () =>
                  startOrResumeThread(
                    buildThreadLifecycleParams(params.signal, { freshStartOnly: true }),
                  ),
              };
            } catch (error) {
              await releaseStartupResources();
              throw error;
            } finally {
              if (releaseStartupResourcesOnTimeout === releaseStartupResources) {
                releaseStartupResourcesOnTimeout = undefined;
              }
            }
          } catch (error) {
            if (sharedClientLease === startupClientLease) {
              sharedClientLease = undefined;
            }
            const shouldAbandonStartupClient =
              clientWorkStarted &&
              (startupAbandoned ||
                params.signal.aborted ||
                isIndeterminateCodexStartupFailure(error));
            if (shouldAbandonStartupClient) {
              attemptedClientAbandoned = true;
              await startupClientLease?.abandon();
            } else {
              startupClientLease?.release();
            }
            throw error;
          }
        };

        for (
          let attempt = 1;
          attempt <= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS;
          attempt += 1
        ) {
          try {
            return await startupAttempt();
          } catch (error) {
            if (params.signal.aborted || !isCodexAppServerConnectionClosedError(error)) {
              throw error;
            }
            if (attempt >= CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS) {
              embeddedAgentLog.warn(
                "codex app-server connection closed during startup; retries exhausted",
                {
                  attempt,
                  maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                  abandonedSharedClient: attemptedClientAbandoned,
                  error: formatErrorMessage(error),
                },
              );
              throw error;
            }
            embeddedAgentLog.warn(
              "codex app-server connection closed during startup; restarting app-server and retrying",
              {
                attempt,
                nextAttempt: attempt + 1,
                maxAttempts: CODEX_APP_SERVER_STARTUP_CONNECTION_CLOSE_MAX_ATTEMPTS,
                abandonedSharedClient: attemptedClientAbandoned,
                error: formatErrorMessage(error),
              },
            );
          }
        }
        throw new Error("codex app-server startup retry loop exited unexpectedly");
      },
    });
    const completedSharedClientLease = sharedClientLease;
    if (!completedSharedClientLease) {
      throw new Error("codex app-server startup succeeded without a shared client lease");
    }
    sharedClientLease = undefined;
    return {
      ...startupResult,
      mcpElicitationDelegationRequired,
      clientLease: completedSharedClientLease,
    };
  } catch (error) {
    const shouldAbandonStartupClient =
      params.signal.aborted || isIndeterminateCodexStartupFailure(error);
    if (shouldAbandonStartupClient) {
      await abandonStartupClient();
    }
    throw error;
  } finally {
    params.signal.removeEventListener("abort", abandonStartupAcquire);
  }
}

function isIndeterminateCodexStartupFailure(error: unknown): boolean {
  return (
    isCodexAppServerUnsafeSubscriptionError(error) ||
    isCodexAppServerConnectionClosedError(error) ||
    (error instanceof Error &&
      (error.message.endsWith(" timed out") ||
        error.message.endsWith(" aborted") ||
        error.message.includes("write EPIPE")))
  );
}
