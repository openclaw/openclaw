import type { AgentToolSurfacePresentation } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
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
  createToolSearchTools,
  type ToolSearchCatalogToolExecutor,
} from "../tool-search.js";
import {
  applyAgentToolSurfaceCatalog,
  resolveAgentToolSurfacePlan,
  type AgentToolSurfacePlanParams,
} from "../tool-surface-plan.js";
import type { AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessPromptToolPolicy } from "./prompt-tool-policy.js";

const CODE_MODE_CONTROL_ALLOWLIST_NAMES = [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME];

type PreparedToolSurface = Pick<
  Parameters<typeof createCodeModeTools>[0],
  "abortSignal" | "executeTool" | "forceRestartSafeTools" | "toolExecutionAllow" | "codeModeSkills"
> & { preserveToolNames: Iterable<string> };

export function createAgentHarnessToolSurfaceRuntimeCore(
  input: Omit<
    AgentToolSurfacePlanParams,
    "forceDirectMessageTool" | "toolsEnabled" | "isRawModelRun"
  > & {
    abortSignal?: AbortSignal;
    executeTool?: ToolSearchCatalogToolExecutor;
    presentation?: AgentToolSurfacePresentation;
    forceMessageTool?: boolean;
    isRawModelRun?: boolean;
    model?: { contextWindow?: number };
    contextTokenBudget?: number;
    modelToolsEnabled: boolean;
    /** False when the harness cannot dispatch an unregistered catalog name directly. */
    supportsDeferredToolCalls?: boolean;
    prompt?: string;
    runId?: string;
    runtimeToolAllowlist?: readonly string[];
    sessionId?: string;
    scheduledToolPolicy?: ScheduledToolPolicyContext;
    sourceReplyDeliveryMode?: string;
  },
) {
  const presentation = input.presentation;
  const params = presentation
    ? {
        ...input,
        config: { tools: { codeMode: presentation.codeMode, toolSearch: presentation.toolSearch } },
      }
    : input;
  const forceDirectMessageTool =
    presentation?.forceDirectMessageTool ?? messageToolOwnsVisibleReply(params);
  // Placement facts cannot restore general execution on a persistence-only turn.
  const plan =
    presentation && params.trigger !== "memory"
      ? {
          codeModeControlsEnabled: presentation.codeMode.enabled,
          toolSearchControlsEnabled: presentation.toolSearch.enabled,
          toolSearchConfig: presentation.toolSearch,
          toolSearchRuntimeConfig: params.config,
        }
      : resolveAgentToolSurfacePlan({
          ...params,
          forceDirectMessageTool,
          toolsEnabled: params.modelToolsEnabled,
          isRawModelRun: params.isRawModelRun === true,
        });
  if (params.supportsDeferredToolCalls === false && plan.toolSearchConfig.mode === "directory") {
    plan.toolSearchConfig = { ...plan.toolSearchConfig, mode: "tools" };
    plan.toolSearchRuntimeConfig = {
      ...plan.toolSearchRuntimeConfig,
      tools: {
        ...plan.toolSearchRuntimeConfig?.tools,
        toolSearch: plan.toolSearchConfig,
      },
    };
  }
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
            ...params,
            tools,
            preserveToolNames,
          });
    let effectiveTools = prepared
      ? projectedUncompactedTools
      : filterRuntimeCompatibleTools(projectedUncompactedTools).tools;
    const codeModeSkills = prepared?.codeModeSkills ?? presentation?.skills;
    const createControls = codeModeControlsEnabled
      ? createCodeModeTools
      : toolSearchControlsEnabled &&
          !effectiveTools.some((tool) => TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name))
        ? createToolSearchTools
        : undefined;
    const controls = createControls
      ? createControls({
          ...params,
          runtimeConfig: codeModeControlsEnabled ? params.config : toolSearchRuntimeConfig,
          modelContextWindowTokens: params.contextTokenBudget ?? params.model?.contextWindow,
          catalogRef: toolSearchCatalogRef,
          abortSignal: prepared?.abortSignal ?? params.abortSignal,
          executeTool: prepared?.executeTool ?? params.executeTool,
          forceRestartSafeTools: prepared?.forceRestartSafeTools,
          toolExecutionAllow: prepared?.toolExecutionAllow,
          codeModeSkills,
        })
      : [];
    const compacted = applyAgentToolSurfaceCatalog({
      ...params,
      tools: [...controls, ...effectiveTools],
      toolSearchRuntimeConfig,
      codeModeControlsEnabled,
      toolSearchConfig,
      forceDirectMessageTool,
      catalogRef: toolSearchCatalogRef,
      toolHookContext: options.hookContext,
      toolExecutionAllow: prepared?.toolExecutionAllow,
      codeModeSkills,
    });
    const projectedCompactedTools =
      !prepared && options.localModelLeanApplied
        ? compacted.tools
        : filterLocalModelLeanTools({
            ...params,
            tools: compacted.tools,
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
        toolSearchPrompt: toolSearchControlsEnabled
          ? {
              config: toolSearchRuntimeConfig,
              contextTokenBudget: params.contextTokenBudget ?? params.model?.contextWindow,
            }
          : undefined,
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
    cleanup: () => clearToolSearchCatalog({ catalogRef: toolSearchCatalogRef }),
    toolSearchCatalogExecutor,
  };
}
