import type {
  AnyAgentTool,
  EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { buildDynamicTools } from "./dynamic-tool-build.js";
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import { createNativeChildDynamicToolExecutor } from "./native-child-tool-executor.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
export type McpExecutionOwner = {
  host: EmbeddedRunAttemptParamsV2["hostCapabilities"];
  runId: string;
  sessionId: string;
  runSessionKey: string;
};
type McpView = { tools: AnyAgentTool[]; dispose: () => Promise<void> };
/** Build fresh execution resources under the admitted child host; a foreground callback is never retained for dispatch. */
export function prepareNativeChildToolExecutor(
  runtime: CodexAttemptRuntime,
  bridge: CodexDynamicToolBridge,
  acquireMcp: (name: string, owner: McpExecutionOwner) => Promise<McpView | null | undefined>,
) {
  const {
    connection,
    runtimeParams,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    authenticatedScheduledMode,
  } = runtime;
  const {
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    sessionPermissionPolicy,
    sessionAgentId,
    policyAgentId,
    pluginConfig,
  } = connection;
  if (
    !pluginConfig.nativeChildTools?.allow?.length ||
    connection.appServer.start.transport !== "stdio" ||
    authenticatedScheduledMode ||
    params.requireWorkspaceOnly ||
    params.oneShotCliRun
  ) {
    return undefined;
  }
  return createNativeChildDynamicToolExecutor({
    policy: pluginConfig.nativeChildTools,
    parent: params.hostCapabilities,
    bridge,
    config: params.config,
    agentId: sessionAgentId,
    workspaceDir: effectiveWorkspace,
    assertPolicyCurrent: runtime.nativeExecutionPolicy.assertCurrent,
    build: async ({ toolName, host, childKey, threadId, runId, signal }) => {
      const view = await acquireMcp(toolName, {
        host,
        runSessionKey: childKey,
        runId,
        sessionId: threadId,
      });
      if (view !== null) {
        try {
          return {
            tools: host.bindToolSurface(view?.tools ?? []),
            dispose: async () => {
              await view?.dispose();
            },
          };
        } catch (error) {
          await view?.dispose();
          throw error;
        }
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.throwIfAborted();
      signal.addEventListener("abort", abort, { once: true });
      const cleanups: Array<(reason: string) => Promise<void>> = [];
      const dispose = async () => {
        signal.removeEventListener("abort", abort);
        controller.abort();
        await Promise.all(
          cleanups.splice(0).map((cleanup) => cleanup("native-child-call-finished")),
        );
      };
      try {
        const tools = await buildDynamicTools({
          params: {
            ...runtimeParams,
            hostCapabilities: host,
            sessionId: threadId,
            sessionKey: childKey,
            runId,
            abortSignal: controller.signal,
            disableMessageTool: true,
            disableTools: params.disableTools,
            onToolOutcome: undefined,
            allocateToolOutcomeOrdinal: undefined,
            onToolResult: undefined,
            onAgentEvent: undefined,
            hasRepliedRef: undefined,
            delegationCapability: undefined,
            isTurnTainted: () => true,
          },
          resolvedWorkspace,
          effectiveWorkspace,
          effectiveCwd,
          sandboxSessionKey,
          sandbox,
          sessionPermissionPolicy,
          nativeToolSurfaceEnabled,
          nativeProviderWebSearchSupport,
          nativeExecutionPolicy: runtime.nativeExecutionPolicy,
          sessionAgentId,
          policyAgentId,
          pluginConfig,
          runAbortController: controller,
          onYieldDetected: () => {
            throw new Error("A native child tool cannot yield its parent.");
          },
          registerRunCleanup: (cleanup) => cleanups.push(cleanup),
        });
        return { tools, dispose };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  });
}
