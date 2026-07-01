import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  applyCodeModeCatalog,
  createCodeModeTools,
  resolveCodeModeConfig,
} from "../code-mode.js";
import {
  applyLocalModelLeanToolSearchDefaults,
  filterLocalModelLeanTools,
  resolveLocalModelLeanPreserveToolNames,
} from "../local-model-lean.js";
import { filterRuntimeCompatibleTools } from "../tool-schema-projection.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  estimateToolSchemaDirectoryToolNames,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../tool-search.js";
import type { AnyAgentTool } from "../tools/common.js";

const TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES = [
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];
const CODE_MODE_CONTROL_ALLOWLIST_NAMES = [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME];

export type AgentHarnessToolSurfaceRuntime = {
  codeModeControlsEnabled: boolean;
  compactTools: (
    tools: AnyAgentTool[],
    options?: { hookContext?: HookContext },
  ) => {
    tools: AnyAgentTool[];
  };
  config: OpenClawConfig | undefined;
  includeToolSearchControls: boolean;
  runtimeToolAllowlist: string[] | undefined;
  toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  toolSearchControlsEnabled: boolean;
  cleanup: () => void;
  toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor | undefined;
};

export function createAgentHarnessToolSurfaceRuntime(params: {
  abortSignal?: AbortSignal;
  agentId?: string;
  config?: OpenClawConfig;
  disableTools?: boolean;
  executeTool: ToolSearchCatalogToolExecutor;
  forceMessageTool?: boolean;
  isRawModelRun?: boolean;
  modelToolsEnabled: boolean;
  prompt?: string;
  runId?: string;
  runtimeToolAllowlist?: readonly string[];
  sessionId?: string;
  sessionKey?: string;
  sourceReplyDeliveryMode?: string;
  toolsAllow?: readonly string[];
}): AgentHarnessToolSurfaceRuntime {
  const forceDirectMessageTool =
    params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
  const codeModeConfig = resolveCodeModeConfig(params.config, params.agentId);
  const toolSearchRuntimeConfig = forceDirectMessageTool
    ? params.config
    : applyLocalModelLeanToolSearchDefaults({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
  const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
  const toolsAvailable =
    params.modelToolsEnabled &&
    params.disableTools !== true &&
    params.isRawModelRun !== true &&
    params.toolsAllow?.length !== 0;
  const codeModeControlsEnabled = toolsAvailable && codeModeConfig.enabled;
  const toolSearchControlsEnabled =
    toolsAvailable && !codeModeControlsEnabled && toolSearchConfig.enabled;
  const toolSearchCatalogRef =
    toolSearchControlsEnabled || codeModeControlsEnabled ? createToolSearchCatalogRef() : undefined;
  const runtimeToolAllowlist =
    (toolSearchControlsEnabled || codeModeControlsEnabled) && params.runtimeToolAllowlist
      ? [
          ...new Set([
            ...params.runtimeToolAllowlist,
            ...(toolSearchControlsEnabled ? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES : []),
            ...(codeModeControlsEnabled ? CODE_MODE_CONTROL_ALLOWLIST_NAMES : []),
          ]),
        ]
      : params.runtimeToolAllowlist
        ? [...params.runtimeToolAllowlist]
        : undefined;
  const toolSearchCatalogExecutor =
    toolSearchControlsEnabled || codeModeControlsEnabled ? params.executeTool : undefined;
  const compactTools = (
    tools: AnyAgentTool[],
    options: { hookContext?: HookContext } = {},
  ): { tools: AnyAgentTool[] } => {
    const preserveToolNames = resolveLocalModelLeanPreserveToolNames({
      toolNames: runtimeToolAllowlist,
      forceMessageTool: params.forceMessageTool,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    });
    const projectedUncompactedTools = filterLocalModelLeanTools({
      tools,
      config: params.config,
      agentId: params.agentId,
      preserveToolNames,
    });
    const uncompactedProjection = filterRuntimeCompatibleTools(projectedUncompactedTools);
    let effectiveTools = [...uncompactedProjection.tools];
    const codeModeTools = codeModeControlsEnabled
      ? createCodeModeTools({
          config: params.config,
          runtimeConfig: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          abortSignal: params.abortSignal,
          executeTool: params.executeTool,
        })
      : [];
    const directoryRequiredToolNames = forceDirectMessageTool ? ["message"] : [];
    const directoryHydratedToolNames =
      toolSearchControlsEnabled && toolSearchConfig.mode === "directory"
        ? (() => {
            try {
              return estimateToolSchemaDirectoryToolNames({
                tools: effectiveTools,
                query: params.prompt ?? "",
                maxTools: 4,
                requiredToolNames: directoryRequiredToolNames,
              });
            } catch {
              return directoryRequiredToolNames;
            }
          })()
        : [];
    const compacted = codeModeControlsEnabled
      ? applyCodeModeCatalog({
          tools: [...codeModeTools, ...effectiveTools],
          config: params.config,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          toolHookContext: options.hookContext,
        })
      : toolSearchConfig.mode === "directory"
        ? applyToolSchemaDirectoryCatalog({
            tools: effectiveTools,
            config: toolSearchRuntimeConfig,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            runId: params.runId,
            catalogRef: toolSearchCatalogRef,
            toolHookContext: options.hookContext,
            hydrateToolNames: directoryHydratedToolNames,
          })
        : applyToolSearchCatalog({
            tools: effectiveTools,
            config: toolSearchRuntimeConfig,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.agentId,
            runId: params.runId,
            catalogRef: toolSearchCatalogRef,
            toolHookContext: options.hookContext,
          });
    const projectedCompactedTools = filterLocalModelLeanTools({
      tools: compacted.tools,
      config: params.config,
      agentId: params.agentId,
      preserveToolNames,
    });
    effectiveTools = [...filterRuntimeCompatibleTools(projectedCompactedTools).tools];
    return { tools: effectiveTools };
  };
  return {
    codeModeControlsEnabled,
    compactTools,
    config: toolSearchControlsEnabled ? toolSearchRuntimeConfig : params.config,
    includeToolSearchControls: toolSearchControlsEnabled,
    runtimeToolAllowlist,
    toolSearchCatalogRef,
    toolSearchControlsEnabled,
    cleanup: () => {
      clearToolSearchCatalog({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        runId: params.runId,
        catalogRef: toolSearchCatalogRef,
      });
    },
    toolSearchCatalogExecutor,
  };
}
