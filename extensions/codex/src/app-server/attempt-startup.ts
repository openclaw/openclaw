import {
  AgentHarnessPreflightError,
  embeddedAgentLog,
  formatErrorMessage,
  type AgentHarnessRuntimeArtifactBinding,
  type CodexBundleMcpThreadConfig,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type resolveSandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  CodexAppServerUnsafeSubscriptionError,
  closeCodexStartupClientBestEffort,
  shouldRetireCodexStartupClient,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { buildCodexPluginThreadConfigEligibilityLogData } from "./attempt-diagnostics.js";
import { verifyStartupArtifact } from "./attempt-runtime-artifact.js";
import { CodexAppServerStartupError, withCodexStartupTimeout } from "./attempt-timeouts.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { startCodexComputerUseHealthMonitor } from "./computer-use-health.js";
import { ensureCodexComputerUse } from "./computer-use.js";
import {
  hasCodexMcpToolApprovalOverrides,
  withMcpElicitationsApprovalPolicy,
  type CodexAppServerRuntimeOptions,
  type CodexPluginConfig,
  type ResolvedCodexComputerUseConfig,
} from "./config.js";
import {
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
  prepareCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { CodexDynamicToolSpec, JsonObject } from "./protocol.js";
import { isCodexResponsesOAuth } from "./responses-oauth.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
  type CodexSandboxExecEnvironment,
} from "./sandbox-exec-server.js";
import type { CodexBindingAuthority, CodexAppServerBindingStore } from "./session-binding.js";
import { observeAcquire } from "./shared-client-lifecycle.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  createIsolatedCodexAppServerClient,
  readCodexAppServerClientDesktopGenerationFingerprint,
  releaseLeasedSharedCodexAppServerClient,
  type CodexAppServerAcquireObservation,
  type CodexAppServerClientOptions,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import type { CodexContextEngineThreadBootstrapProjection } from "./thread-context-engine.js";
import { CodexThreadClientReplacementError } from "./thread-lifecycle-errors.js";
import { startOrResumeThread } from "./thread-lifecycle-run.js";
import { getCodexAppServerTurnRouter, type CodexThreadRouteReservation } from "./turn-router.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

type CodexSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;

/**
 * Starts or resumes the Codex app-server thread and returns the resources the
 * run loop must later release.
 */
export async function startCodexAttemptThread(params: {
  assertCurrent?: () => void;
  authority?: CodexBindingAuthority;
  attemptClientFactory: CodexAppServerClientFactory;
  bindingStore: CodexAppServerBindingStore;
  runtime?: PluginRuntime;
  appServer: CodexAppServerRuntimeOptions;
  pluginConfig: CodexPluginConfig;
  computerUseConfig: ResolvedCodexComputerUseConfig;
  clientOptions: CodexAppServerClientOptions;
  runtimeArtifactRequest?: Readonly<{
    expected?: AgentHarnessRuntimeArtifactBinding;
  }>;
  startupAuthAccountCacheKey: string | undefined;
  startupEnvApiKeyCacheKey: string | undefined;
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  shellEnvironment?: Readonly<Record<string, string>>;
  shellPathPrepend?: readonly string[];
  shellGitConfigParameters?: string;
  disableLoginShell?: boolean;
  buildAttemptParams: () => EmbeddedRunAttemptParams;
  runtimeModelId?: string;
  sessionAgentId: string;
  effectiveWorkspace: string;
  effectiveCwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  persistentWebSearchAllowed?: boolean;
  webSearchAllowed: boolean;
  developerInstructions: string | undefined;
  refreshableInstructions?: string;
  agentWorkspaceDeveloperInstructions?: string;
  buildFinalConfigPatch?: Parameters<typeof startOrResumeThread>[0]["buildFinalConfigPatch"];
  nativeHookRelayRequired?: boolean;
  nativeModelAdmission?: Parameters<typeof startOrResumeThread>[0]["nativeModelAdmission"];
  bundleMcpThreadConfig: CodexBundleMcpThreadConfig;
  /** Static configured MCP is present on the dynamic surface, so native MCP stays absent. */
  configuredMcpDynamicSurface?: boolean;
  /** OpenClaw owns configured MCP dynamically for this scheduled turn. */
  configuredMcpOwnershipVersion?: 1;
  nativeToolSurfaceEnabled: boolean;
  nativeProviderWebSearchSupport: CodexNativeWebSearchSupport;
  sandboxExecServerEnabled: boolean;
  sandbox: CodexSandboxContext;
  contextEngineProjection: CodexContextEngineThreadBootstrapProjection | undefined;
  startupTimeoutMs: number;
  signal: AbortSignal;
  onStartupTimeout: () => void | Promise<void>;
  onExecutionDisconnect?: (error: Error) => void;
  spawnedBy: EmbeddedRunAttemptParams["spawnedBy"];
}) {
  let pluginAppServer = params.appServer;
  const startupRuntimeAuthProfileId =
    params.clientOptions.preparedAuth?.kind === "profile"
      ? params.clientOptions.preparedAuth.profileId
      : (params.clientOptions.authProfileId ?? undefined);
  const startupRuntimeAuthProfileStore =
    params.clientOptions.preparedAuth?.kind === "profile"
      ? params.clientOptions.preparedAuth.store
      : undefined;
  let releaseSharedClientLease: (() => void) | undefined;
  let startupClientForAbandonedRequestCleanup: CodexAppServerClient | undefined;
  let releaseStartupResourcesOnTimeout: (() => Promise<void>) | undefined;
  const startupStartedAt = performance.now();
  let stage = "configuration";
  let stageStartedAt = startupStartedAt;
  let acquireBoundary: CodexAppServerAcquireObservation["boundary"] | undefined;
  let startupIdentity: Pick<EmbeddedRunAttemptParams, "runId" | "sessionId"> | undefined;
  let startupAttemptNumber = 0;
  const enterStartupStage = (nextStage: string) => {
    stage = nextStage;
    stageStartedAt = performance.now();
    acquireBoundary = undefined;
  };
  const startupAbandonController = new AbortController();
  const abandonStartupAcquire = () => startupAbandonController.abort();
  params.signal.addEventListener("abort", abandonStartupAcquire, { once: true });
  try {
    const startupResult = await withCodexStartupTimeout({
      timeoutMs: params.startupTimeoutMs,
      signal: params.signal,
      onTimeout: async () => {
        // Capture before abort/retirement settles requests and erases the blocked boundary.
        // Diagnostic failures must not prevent cancellation or resource cleanup.
        try {
          const client = startupClientForAbandonedRequestCleanup;
          const now = performance.now();
          embeddedAgentLog.warn("codex app-server startup timed out", {
            ...startupIdentity,
            attempt: startupAttemptNumber,
            stage,
            stageElapsedMs: Math.max(0, Math.round(now - stageStartedAt)),
            elapsedMs: Math.max(0, Math.round(now - startupStartedAt)),
            timeoutMs: params.startupTimeoutMs,
            acquireBoundary,
            clientInstanceId: client?.getInstanceId(),
            clientPendingRequestMethods: client?.getPendingRequestMethods() ?? [],
          });
        } catch {
          // Logging is observational, not an owner of the startup deadline.
        }
        startupAbandonController.abort();
        await params.onStartupTimeout();
        await releaseStartupResourcesOnTimeout?.();
        releaseSharedClientLease?.();
        releaseSharedClientLease = undefined;
        await closeCodexStartupClientBestEffort(startupClientForAbandonedRequestCleanup);
        startupClientForAbandonedRequestCleanup = undefined;
      },
      operation: async () => {
        const threadConfig = mergeCodexThreadConfigs(
          params.configuredMcpDynamicSurface
            ? undefined
            : (params.bundleMcpThreadConfig?.configPatch as JsonObject | undefined),
        );
        const pluginStartupPolicy = resolveCodexPluginThreadConfigStartupPolicy({
          pluginConfig: params.pluginConfig,
          nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
          hostedAppsSupported: !isCodexResponsesOAuth(params.clientOptions.preparedAuth),
          scheduledRuntimeAuthority: params.buildAttemptParams().scheduledRuntimeAuthority,
        });
        const { pluginThreadConfigRequired, resolvedPluginPolicy, enabledPluginConfigKeys } =
          pluginStartupPolicy;
        const mcpElicitationDelegationRequired =
          resolvedPluginPolicy?.enabled === true ||
          params.computerUseConfig.enabled ||
          (params.nativeToolSurfaceEnabled &&
            params.configuredMcpOwnershipVersion !== 1 &&
            hasCodexMcpToolApprovalOverrides(
              params.config?.mcp?.servers,
              params.bundleMcpThreadConfig.userStaticServerNames,
              params.bundleMcpThreadConfig.configPatch?.mcp_servers,
            ));
        pluginAppServer = mcpElicitationDelegationRequired
          ? {
              ...params.appServer,
              approvalPolicy: withMcpElicitationsApprovalPolicy(params.appServer.approvalPolicy),
            }
          : params.appServer;

        const startupAttempt = async () => {
          startupAttemptNumber += 1;
          let startupClientLease: (() => void) | undefined;
          let startupClient: CodexAppServerClient | undefined;
          let startupAttemptError: unknown;
          let startupAttemptSucceeded = false;
          try {
            const attemptParams = params.buildAttemptParams();
            startupIdentity = { runId: attemptParams.runId, sessionId: attemptParams.sessionId };
            params.assertCurrent?.();
            if (startupAbandonController.signal.aborted) {
              throw new CodexAppServerStartupError("aborted");
            }
            enterStartupStage("client-acquire");
            startupClient = await params.attemptClientFactory({
              ...params.clientOptions,
              onAcquireObservation: (observation) => {
                if (stage === "client-acquire") {
                  acquireBoundary = observation.boundary;
                }
                observeAcquire(params.clientOptions, observation);
              },
              // Process startup retains its synchronous admission contract. Ordinary
              // native requests use the retained worker authority at wire admission.
              assertCurrent: () => {
                params.assertCurrent?.();
                params.authority?.assertLegacyCurrent();
              },
              startOptions: params.appServer.start,
              pluginConfig: params.pluginConfig,
              authProfileStore: attemptParams.authProfileStore,
              agentId: params.sessionAgentId,
              agentDir: params.agentDir,
              config: params.config,
              onStartedClient: (client) => {
                // Timeout cleanup may fire before the client factory resolves;
                // close any late-arriving client instead of leaking a lease.
                startupClientForAbandonedRequestCleanup = client;
                if (startupAbandonController.signal.aborted) {
                  void closeCodexStartupClientBestEffort(client);
                }
              },
              abandonSignal: startupAbandonController.signal,
              timeoutMs: params.appServer.requestTimeoutMs,
            });
            const activeStartupClient = startupClient;
            let startupClientLeaseReleased = false;
            startupClientLease = () => {
              if (startupClientLeaseReleased) {
                return;
              }
              startupClientLeaseReleased = true;
              if (params.attemptClientFactory === createIsolatedCodexAppServerClient) {
                activeStartupClient.close();
              } else {
                releaseLeasedSharedCodexAppServerClient(activeStartupClient);
              }
            };
            releaseSharedClientLease = startupClientLease;
            startupClientForAbandonedRequestCleanup = activeStartupClient;
            if (startupAbandonController.signal.aborted) {
              throw new CodexAppServerStartupError("aborted");
            }
            enterStartupStage("runtime-artifact");
            const runtimeArtifact = await verifyStartupArtifact({
              client: activeStartupClient,
              startOptions: params.appServer.start,
              request: params.runtimeArtifactRequest,
              signal: startupAbandonController.signal,
            });
            params.assertCurrent?.();
            ensureCodexAppServerClientRuntime(activeStartupClient, {
              agentDir: params.agentDir,
              authProfileId: startupRuntimeAuthProfileId,
              authMode:
                params.clientOptions.preparedAuth?.kind === "api-key" ||
                isCodexResponsesOAuth(params.clientOptions.preparedAuth)
                  ? "prepared-api-key"
                  : "profile",
              authProfileStore: startupRuntimeAuthProfileStore ?? attemptParams.authProfileStore,
              config: params.config,
            });
            const turnRouter = getCodexAppServerTurnRouter(activeStartupClient);
            let computerUseTools: string[] = [];
            let computerUseConfig = params.computerUseConfig;
            try {
              enterStartupStage("computer-use");
              const computerUseStatus = await ensureCodexComputerUse({
                client: activeStartupClient,
                pluginConfig: params.pluginConfig,
                config: params.config,
                agentDir: params.agentDir,
                timeoutMs: params.appServer.requestTimeoutMs,
                signal: startupAbandonController.signal,
              });
              computerUseTools = computerUseStatus.tools;
              computerUseConfig = {
                ...computerUseConfig,
                pluginName: computerUseStatus.pluginName,
                mcpServerName: computerUseStatus.mcpServerName,
              };
            } catch (error) {
              if (startupAbandonController.signal.aborted) {
                throw error;
              }
              throw new AgentHarnessPreflightError(
                `Codex Computer Use readiness failed: ${formatErrorMessage(error)}`,
                { cause: error, scope: "harness" },
              );
            }
            const startupRuntimeIdentity = activeStartupClient.getRuntimeIdentity();
            const pluginAppCacheKey = buildCodexPluginAppCacheKey({
              appServer: params.appServer,
              agentDir: params.agentDir,
              authProfileId: startupRuntimeAuthProfileId,
              accountId: params.startupAuthAccountCacheKey,
              envApiKeyFingerprint: params.startupEnvApiKeyCacheKey,
              appServerVersion: activeStartupClient.getServerVersion(),
              runtimeIdentity: startupRuntimeIdentity,
              desktopGenerationFingerprint:
                readCodexAppServerClientDesktopGenerationFingerprint(activeStartupClient),
            });
            const appServerRuntimeFingerprint = buildCodexAppServerRuntimeFingerprint({
              appServer: params.appServer,
              appServerVersion: activeStartupClient.getServerVersion(),
              runtimeIdentity: startupRuntimeIdentity,
            });
            const createPluginThreadConfig = prepareCodexPluginThreadConfigStartupProvider({
              startupPolicy: pluginStartupPolicy,
              appCacheKey: pluginAppCacheKey,
              scheduledRuntimeAuthority: attemptParams.scheduledRuntimeAuthority,
            });
            embeddedAgentLog.debug(
              "codex plugin thread config eligibility",
              buildCodexPluginThreadConfigEligibilityLogData({
                sessionId: attemptParams.sessionId,
                sessionKey: attemptParams.sessionKey ?? "",
                pluginThreadConfigRequired,
                resolvedPluginPolicy,
                enabledPluginConfigKeys,
                pluginAppCacheKey,
                startupAuthProfileId: startupRuntimeAuthProfileId,
                appServer: params.appServer,
              }),
            );
            let startupSandboxEnvironment: CodexSandboxExecEnvironment | undefined;
            let startupSandboxEnvironmentAcquired = false;
            const releaseStartupSandboxEnvironment = async () => {
              if (startupSandboxEnvironmentAcquired) {
                startupSandboxEnvironmentAcquired = false;
                await releaseCodexSandboxExecServerEnvironment(
                  params.sandbox,
                  startupSandboxEnvironment,
                );
              }
            };
            releaseStartupResourcesOnTimeout = releaseStartupSandboxEnvironment;
            try {
              params.assertCurrent?.();
              const sandboxEnvironmentRequired = shouldRequireCodexSandboxExecServerEnvironment({
                sandbox: params.sandbox,
                nativeToolSurfaceEnabled: params.nativeToolSurfaceEnabled,
                sandboxExecServerEnabled: params.sandboxExecServerEnabled,
              });
              enterStartupStage("sandbox-environment");
              startupSandboxEnvironment = sandboxEnvironmentRequired
                ? await ensureCodexSandboxExecServerEnvironment({
                    client: activeStartupClient,
                    sandbox: params.sandbox ?? null,
                    runtime: params.runtime,
                    appServerStartOptions: params.appServer.start,
                    timeoutMs: params.appServer.requestTimeoutMs,
                    // Paired-node channels outlive startup's abort forwarding;
                    // retain run cancellation after this function returns.
                    signal: AbortSignal.any([params.signal, startupAbandonController.signal]),
                    onExecutionDisconnect: params.onExecutionDisconnect,
                    requireProcessAuthority: Boolean(
                      attemptParams.hostCapabilities.retainSourceAuthority,
                    ),
                  })
                : undefined;
              startupSandboxEnvironmentAcquired = Boolean(startupSandboxEnvironment);
              if (startupAbandonController.signal.aborted) {
                throw new CodexAppServerStartupError("aborted");
              }
              if (sandboxEnvironmentRequired && !startupSandboxEnvironment) {
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
            let startupReservation: CodexThreadRouteReservation | undefined;
            const releaseStartupReservation = () => {
              startupReservation?.release();
              startupReservation = undefined;
            };
            const reserveStartupThread = (threadId: string) => {
              if (startupReservation) {
                if (startupReservation.threadId !== threadId) {
                  throw new Error(
                    `codex app-server reserved ${startupReservation.threadId} but started ${threadId}`,
                  );
                }
                return { release: releaseStartupReservation };
              }
              startupReservation = turnRouter.reserveThread({
                threadId,
              });
              return { release: releaseStartupReservation };
            };
            const releaseStartupResources = async () => {
              enterStartupStage("resource-cleanup");
              releaseStartupReservation();
              await releaseStartupSandboxEnvironment();
            };
            releaseStartupResourcesOnTimeout = releaseStartupResources;
            const buildThreadLifecycleParams = (
              signal: AbortSignal,
              reserveResumeThread?: typeof reserveStartupThread,
            ) =>
              ({
                client: activeStartupClient,
                reserveResumeThread,
                bindingStore: params.bindingStore,
                assertCurrent: params.assertCurrent,
                authority: params.authority,
                params: params.buildAttemptParams(),
                runtimeModelId: params.runtimeModelId,
                agentId: params.sessionAgentId,
                agentDir: params.agentDir,
                cwd: startupExecutionCwd,
                dynamicTools: params.dynamicTools,
                persistentWebSearchAllowed: params.persistentWebSearchAllowed,
                webSearchAllowed: params.webSearchAllowed,
                appServer: pluginAppServer,
                developerInstructions: params.developerInstructions,
                refreshableInstructions: params.refreshableInstructions,
                agentWorkspaceDeveloperInstructions: params.agentWorkspaceDeveloperInstructions,
                config: threadConfig,
                shellEnvironment: params.shellEnvironment,
                shellPathPrepend: params.shellPathPrepend,
                shellGitConfigParameters: params.shellGitConfigParameters,
                disableLoginShell: params.disableLoginShell,
                buildFinalConfigPatch: params.buildFinalConfigPatch,
                nativeHookRelayRequired: params.nativeHookRelayRequired,
                nativeModelAdmission: params.nativeModelAdmission,
                nativeCodeModeEnabled: params.nativeToolSurfaceEnabled,
                nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
                nativeCodeModeOnlyEnabled: params.appServer.codeModeOnly,
                userMcpServersEnabled: params.configuredMcpDynamicSurface
                  ? false
                  : params.nativeToolSurfaceEnabled,
                mcpServersFingerprint: params.configuredMcpDynamicSurface
                  ? undefined
                  : params.bundleMcpThreadConfig.fingerprint,
                mcpServersFingerprintEvaluated:
                  params.configuredMcpDynamicSurface || params.bundleMcpThreadConfig.evaluated,
                configuredMcpOwnershipVersion: params.configuredMcpOwnershipVersion,
                environmentSelection: startupEnvironmentSelection,
                appServerRuntimeFingerprint,
                contextEngineProjection: params.contextEngineProjection,
                signal,
                pluginThreadConfig: createPluginThreadConfig?.({
                  requestTimeoutMs: params.appServer.requestTimeoutMs,
                  signal,
                  client: activeStartupClient,
                  configCwd: startupExecutionCwd,
                  scheduledRuntimeAuthority: attemptParams.scheduledRuntimeAuthority,
                }),
              }) satisfies Parameters<typeof startOrResumeThread>[0];
            try {
              enterStartupStage("thread-lifecycle");
              const startupThread = await startOrResumeThread(
                buildThreadLifecycleParams(startupAbandonController.signal, reserveStartupThread),
              );
              try {
                // Fresh starts reach here unreserved; resumes reserved before
                // thread/resume so their early notifications are already buffered.
                reserveStartupThread(startupThread.threadId);
              } catch (error) {
                enterStartupStage("subscription-cleanup");
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
                throw new CodexAppServerStartupError("aborted");
              }
              const startupRoute = startupReservation;
              if (!startupRoute) {
                throw new Error("codex app-server startup did not reserve its thread route");
              }
              startupSandboxEnvironmentAcquired = false;
              startCodexComputerUseHealthMonitor({
                client: activeStartupClient,
                config: computerUseConfig,
                tools: computerUseTools,
              });
              startupAttemptSucceeded = true;
              return {
                client: activeStartupClient,
                turnRouter,
                turnRoute: startupRoute,
                thread: startupThread,
                sandboxEnvironment: startupSandboxEnvironment,
                environmentSelection: startupEnvironmentSelection,
                executionCwd: startupExecutionCwd,
                sandboxPolicy: startupSandboxPolicy,
                ...(runtimeArtifact ? { runtimeArtifact } : {}),
                restartContextEngineCodexThread: async () => {
                  // A fresh thread cannot reuse the old thread's bootstrap receipt.
                  return await startOrResumeThread({
                    ...buildThreadLifecycleParams(params.signal),
                    contextEngineProjection: undefined,
                  });
                },
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
            startupAttemptError = error;
            if (!startupAbandonController.signal.aborted && !startupClient) {
              const sharedClient = clearSharedCodexAppServerClientIfCurrentAndUnclaimed(
                startupClientForAbandonedRequestCleanup,
              );
              if (sharedClient.found && !sharedClient.closed) {
                // Shared acquisition already released this caller. A peer still
                // owns the client, so outer cleanup must not retire it.
                startupClientForAbandonedRequestCleanup = undefined;
              }
            }
          } finally {
            if (!startupAttemptSucceeded) {
              if (releaseSharedClientLease === startupClientLease) {
                releaseSharedClientLease = undefined;
              }
              startupClientLease?.();
              if (
                shouldRetireCodexStartupClient(
                  startupAttemptError,
                  params.spawnedBy,
                  startupAbandonController.signal,
                )
              ) {
                if (startupClientForAbandonedRequestCleanup === startupClient) {
                  startupClientForAbandonedRequestCleanup = undefined;
                }
                enterStartupStage("client-retirement");
                await closeCodexStartupClientBestEffort(startupClient);
              }
            }
          }
          if (startupAttemptError instanceof CodexThreadClientReplacementError && startupClient) {
            // Releasing the last lease starts closure; the native writer lock
            // belongs to the old process until its physical exit is confirmed.
            enterStartupStage("client-retirement");
            const closed = await startupClient.closeAndWait();
            if (!closed.exited) {
              throw new AgentHarnessPreflightError(
                "The previous conversation process did not confirm shutdown; the conversation was preserved.",
              );
            }
          }
          throw startupAttemptError;
        };

        try {
          return await startupAttempt();
        } catch (error) {
          if (
            startupAbandonController.signal.aborted ||
            !(error instanceof CodexThreadClientReplacementError)
          ) {
            throw error;
          }
          // A settled thread that could not unload requires one fresh process.
          return await startupAttempt();
        }
      },
    });
    startupClientForAbandonedRequestCleanup = undefined;
    if (!releaseSharedClientLease) {
      throw new Error("codex app-server startup succeeded without a shared client lease");
    }
    return {
      ...startupResult,
      pluginAppServer,
      releaseSharedClientLease,
    };
  } catch (error) {
    if (shouldRetireCodexStartupClient(error, params.spawnedBy, startupAbandonController.signal)) {
      releaseSharedClientLease?.();
      releaseSharedClientLease = undefined;
      await closeCodexStartupClientBestEffort(startupClientForAbandonedRequestCleanup);
      startupClientForAbandonedRequestCleanup = undefined;
    }
    throw error;
  } finally {
    params.signal.removeEventListener("abort", abandonStartupAcquire);
  }
}
