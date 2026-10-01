import {
  buildAgentHookContextChannelFields,
  resolveSandboxContext,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { readCodexPluginConfig } from "./config.js";
import { buildDynamicTools, resolveCodexMessageToolProvider } from "./dynamic-tool-build.js";
import { resolveCodexDynamicToolsLoading } from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexEffectiveSessionPermissionPolicy } from "./session-permission-policy.js";
import {
  resolveCodexWebSearchPlan,
  type CodexNativeWebSearchSupport,
  type CodexWebSearchPlan,
} from "./web-search.js";

export async function createCodexSideToolBridge(input: {
  params: EmbeddedRunAttemptParamsV2;
  cwd: string;
  resolvedWorkspace: string;
  pluginConfig: ReturnType<typeof readCodexPluginConfig>;
  sessionAgentId: string;
  nativeToolSurfaceEnabled: boolean;
  nativeProviderWebSearchSupport: CodexNativeWebSearchSupport;
  sessionPermissionPolicy?: CodexEffectiveSessionPermissionPolicy;
  runAbortController: AbortController;
}): Promise<{ toolBridge: CodexDynamicToolBridge; webSearchPlan: CodexWebSearchPlan }> {
  const { params } = input;
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() ||
    params.sessionKey?.trim() ||
    params.sessionId ||
    input.sessionAgentId;
  const sandbox =
    params.sandbox !== undefined
      ? params.sandbox
      : await resolveSandboxContext({
          config: params.config,
          sessionKey: sandboxSessionKey,
          workspaceDir: input.cwd,
        });
  let webSearchAllowed = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace: input.resolvedWorkspace,
    effectiveWorkspace: input.cwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
    sessionPermissionPolicy: input.sessionPermissionPolicy,
    runAbortController: input.runAbortController,
    sessionAgentId: input.sessionAgentId,
    policyAgentId: input.sessionAgentId,
    pluginConfig: input.pluginConfig,
    onYieldDetected: () => {},
    onWebSearchPolicyResolved: (allowed) => {
      webSearchAllowed = allowed;
    },
  });
  const requestedWebSearchPlan = resolveCodexWebSearchPlan({
    config: params.config,
    nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
    webSearchAllowed,
  });
  // Forks inherit dynamic declarations; BTW retains its native-only search policy.
  const webSearchPlan =
    requestedWebSearchPlan.kind === "managed"
      ? resolveCodexWebSearchPlan({ config: params.config, webSearchAllowed: false })
      : requestedWebSearchPlan;
  // Side threads do not own the compaction lifecycle that expires screenshot coordinates.
  const exposedTools = tools.filter(
    (tool) => tool.name !== "web_search" && tool.name !== "computer",
  );
  return {
    toolBridge: createCodexDynamicToolBridge({
      tools: exposedTools,
      signal: input.runAbortController.signal,
      loading: resolveCodexDynamicToolsLoading(input.pluginConfig),
      hookContext: {
        agentId: input.sessionAgentId,
        config: params.config,
        contextWindowTokens: params.model.contextWindow,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        currentChannelProvider: resolveCodexMessageToolProvider(params),
        ...buildAgentHookContextChannelFields(params),
      },
    }),
    webSearchPlan,
  };
}
