import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
} from "../code-mode.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  filterLocalModelLeanTools,
  resolveLocalModelLeanPreserveToolNames,
} from "../local-model-lean.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import { filterRuntimeCompatibleTools } from "../tool-schema-projection.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../tool-search-types.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../tool-search.js";
import { applyAgentToolSurfaceCatalog, resolveAgentToolSurfacePlan } from "../tool-surface-plan.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessPromptToolPolicy } from "./prompt-tool-policy.js";

const CODE_MODE_CONTROL_ALLOWLIST_NAMES = [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME];

type PreparedToolSurface = Pick<
  Parameters<typeof createCodeModeTools>[0],
  "abortSignal" | "executeTool" | "forceRestartSafeTools" | "toolExecutionAllow" | "codeModeSkills"
> & { preserveToolNames: Iterable<string> };

export function createAgentHarnessToolSurfaceRuntimeCore(params: {
  abortSignal?: AbortSignal;
  agentId?: string;
  config?: OpenClawConfig;
  disableTools?: boolean;
  executeTool: ToolSearchCatalogToolExecutor;
  forceMessageTool?: boolean;
  isRawModelRun?: boolean;
  /** Prepared model row carrying catalog compat; required for `"auto"` code-mode resolution. */
  model?: { compat?: unknown; contextWindow?: number; toolSearchMode?: "tools" | false };
  contextTokenBudget?: number;
  modelId?: string;
  modelProvider?: string;
  codeModeOverride?: boolean | "auto";
  disableToolSearch?: true;
  forceCodeModeControls?: boolean;
  modelToolsEnabled: boolean;
  prompt?: string;
  runId?: string;
  runtimeToolAllowlist?: readonly string[];
  sessionId?: string;
  sessionKey?: string;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  sourceReplyDeliveryMode?: string;
  toolsAllow?: readonly string[];
}) {
  const forceDirectMessageTool = messageToolOwnsVisibleReply(params);
  const plan = resolveAgentToolSurfacePlan({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    forceDirectMessageTool,
    model: params.model,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    codeModeOverride: params.codeModeOverride,
    disableToolSearch: params.disableToolSearch,
    toolsEnabled: params.modelToolsEnabled,
    disableTools: params.disableTools,
    isRawModelRun: params.isRawModelRun === true,
    toolsAllow: params.toolsAllow,
    forceCodeModeControls: params.forceCodeModeControls,
  });
  const {
    codeModeControlsEnabled,
    toolSearchControlsEnabled,
    toolSearchConfig,
    toolSearchRuntimeConfig,
  } = plan;
  const toolSearchCatalogRef =
    toolSearchControlsEnabled || codeModeControlsEnabled ? createToolSearchCatalogRef() : undefined;
  const runtimeToolAllowlist = mergeForcedEmbeddedAttemptToolsAllow(params.runtimeToolAllowlist, {
    forceToolNames: [
      ...(toolSearchControlsEnabled ? TOOL_SEARCH_CONTROL_TOOL_NAMES : []),
      ...(codeModeControlsEnabled ? CODE_MODE_CONTROL_ALLOWLIST_NAMES : []),
    ],
  });
  const toolSearchCatalogExecutor =
    toolSearchControlsEnabled || codeModeControlsEnabled ? params.executeTool : undefined;
  let runtimePreserveToolNames: string[] | undefined;
  const preserveRuntimeTools = () =>
    (runtimePreserveToolNames ??= resolveLocalModelLeanPreserveToolNames({
      toolNames: resolveConversationCapabilityProfile({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        modelProvider: params.modelProvider,
        modelId: params.modelId,
        runtimeToolAllowlist,
        scheduledToolPolicy: params.scheduledToolPolicy,
      }).policy.explicitToolOverrideAllowlist,
      forceMessageTool: params.forceMessageTool,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    }));
  const compactTools = (
    tools: AnyAgentTool[],
    options: {
      hookContext?: HookContext;
      localModelLeanApplied?: boolean;
      prepared?: PreparedToolSurface;
    } = {},
  ) => {
    const prepared = options.prepared;
    const preserveToolNames =
      prepared?.preserveToolNames ??
      (options.localModelLeanApplied ? undefined : preserveRuntimeTools());
    // Core already projected bundle/client tools. Its newly added controls still
    // need the final lean pass; native constructors may have applied both passes.
    const projectedUncompactedTools =
      prepared || options.localModelLeanApplied
        ? tools
        : filterLocalModelLeanTools({
            tools,
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            preserveToolNames,
          });
    let effectiveTools = prepared
      ? projectedUncompactedTools
      : filterRuntimeCompatibleTools(projectedUncompactedTools).tools;
    const codeModeTools = codeModeControlsEnabled
      ? createCodeModeTools({
          config: params.config,
          runtimeConfig: params.config,
          modelContextWindowTokens: params.contextTokenBudget ?? params.model?.contextWindow,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          abortSignal: prepared?.abortSignal ?? params.abortSignal,
          executeTool: prepared?.executeTool ?? params.executeTool,
          forceRestartSafeTools: prepared?.forceRestartSafeTools,
          toolExecutionAllow: prepared?.toolExecutionAllow,
          codeModeSkills: prepared?.codeModeSkills,
        })
      : [];
    const compacted = applyAgentToolSurfaceCatalog({
      tools: [...codeModeTools, ...effectiveTools],
      config: params.config,
      toolSearchRuntimeConfig,
      codeModeControlsEnabled,
      toolSearchConfig,
      forceDirectMessageTool,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      runId: params.runId,
      catalogRef: toolSearchCatalogRef,
      toolHookContext: options.hookContext,
      toolExecutionAllow: prepared?.toolExecutionAllow,
      codeModeSkills: prepared?.codeModeSkills,
    });
    const projectedCompactedTools =
      !prepared && options.localModelLeanApplied
        ? compacted.tools
        : filterLocalModelLeanTools({
            tools: compacted.tools,
            config: params.config,
            agentId: params.agentId,
            sessionKey: prepared ? undefined : params.sessionKey,
            preserveToolNames,
          });
    const schemaProjection = filterRuntimeCompatibleTools(projectedCompactedTools);
    effectiveTools = schemaProjection.tools;
    if (!compacted.catalogRegistered) {
      finalizeAgentToolAvailability(effectiveTools, {
        toolExecutionAllow: prepared?.toolExecutionAllow,
      });
    }
    return {
      tools: effectiveTools,
      catalog: compacted,
      projectedTools: projectedCompactedTools,
      diagnostics: schemaProjection.diagnostics,
      promptToolPolicy: createAgentHarnessPromptToolPolicy({
        tools: effectiveTools,
        catalogRef: toolSearchCatalogRef,
        codeModeControlsEnabled,
      }),
    };
  };
  return {
    plan,
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
