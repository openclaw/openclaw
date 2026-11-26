import {
  getPluginToolMeta,
  type AnyAgentTool,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithCodexNativeChildToolHost } from "openclaw/plugin-sdk/codex-mcp-projection";
import type { CodexPluginConfig } from "./config.js";
import { createCodexDynamicToolDiagnostics } from "./dynamic-tool-diagnostics.js";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import { resolveNativeChildToolCatalog } from "./native-child-tool-policy.js";
import type { NativeChildDynamicToolExecutor } from "./native-subagent-monitor-types.js";

type ToolHost = EmbeddedRunAttemptParamsV2["hostCapabilities"];
type ChildToolResources = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

function implementationIdentity(tool: AnyAgentTool) {
  const meta = getPluginToolMeta(tool);
  return JSON.stringify([
    meta?.pluginId,
    meta?.mcp?.serverName,
    meta?.mcp?.toolName,
    meta?.mcp?.operation,
  ]);
}

export function createNativeChildDynamicToolExecutor(params: {
  parent: ToolHost;
  bridge: CodexDynamicToolBridge;
  policy: CodexPluginConfig["nativeChildTools"];
  config: EmbeddedRunAttemptParamsV2["config"];
  agentId: string;
  workspaceDir: string;
  assertPolicyCurrent: () => Promise<void>;
  build: (input: {
    toolName: string;
    host: ToolHost;
    childKey: string;
    threadId: string;
    runId: string;
    signal: AbortSignal;
  }) => Promise<ChildToolResources>;
}): NativeChildDynamicToolExecutor {
  // Save identities and declarations, not the foreground tool callbacks.
  const { tools: rows } = resolveNativeChildToolCatalog({
    policy: params.policy,
    availableTools: params.bridge.availableTools,
  });
  const catalog = new Map(rows.map((row) => [row.name, row]));
  const specs = params.bridge.availableSpecs;
  const identities = new Map(
    params.bridge.availableTools.map((tool) => [tool.name, implementationIdentity(tool)]),
  );
  return async ({
    call,
    runId: childKey,
    source,
    signal,
    assertCurrent,
    setExecutionTimeoutMs,
  }) => {
    const row = catalog.get(call.tool);
    if (row?.status !== "allowed") {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: row?.reason ?? "Not on the owning parent's executable tool surface.",
          },
        ],
      };
    }
    await params.assertPolicyCurrent();
    return await runWithCodexNativeChildToolHost(
      params.parent,
      source,
      {
        threadId: call.threadId,
        toolName: call.tool,
        childRunId: childKey,
        signal,
        assertCurrent,
      },
      async (host, runId) => {
        const resources = await params.build({
          toolName: call.tool,
          host,
          childKey,
          threadId: call.threadId,
          runId,
          signal,
        });
        try {
          const tool = resources.tools.find((t) => t.name === call.tool);
          if (
            !tool ||
            identities.get(call.tool) !== implementationIdentity(tool) ||
            resolveNativeChildToolCatalog({ policy: params.policy, availableTools: [tool] })
              .tools[0]?.status !== "allowed"
          ) {
            return {
              success: false,
              contentItems: [
                {
                  type: "inputText",
                  text: "Delegated tool is no longer available from its admitted owner.",
                },
              ],
            };
          }
          const hookContext = {
            agentId: params.agentId,
            config: params.config,
            sessionKey: childKey,
            sessionId: call.threadId,
            runId,
            workspaceDir: params.workspaceDir,
          };
          const bridge = createCodexDynamicToolBridge({
            tools: [tool],
            registeredSpecs: specs,
            requireExactRegisteredDefinitions: true,
            signal,
            assertCurrent: host.assertActive,
            assertCurrentAsync: params.assertPolicyCurrent,
            hookContext,
          });
          const timeoutMs = resolveDynamicToolCallTimeoutMs({
            call,
            config: params.config,
            toolBridge: bridge,
          });
          setExecutionTimeoutMs?.(timeoutMs);
          const diagnostics = createCodexDynamicToolDiagnostics({ call, ...hookContext });
          const started = Date.now();
          diagnostics.started();
          const result = await handleDynamicToolCallWithTimeout({
            call,
            toolBridge: bridge,
            signal,
            timeoutMs,
          });
          diagnostics.terminal(result, Date.now() - started);
          return toCodexDynamicToolProtocolResponse(result);
        } finally {
          await resources.dispose();
        }
      },
    );
  };
}
