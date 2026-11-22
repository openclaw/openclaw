import type { AgentToolSurfacePresentation } from "../../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import type { ModelSizeClass } from "../../config/types.models.js";
import {
  filterToolsByAgentProfile,
  hasCompactToolProfile,
  resolveAgentProfile,
  resolveAgentProfilePreserveToolNames,
} from "../agent-profiles.js";
import { resolveProfileModelSizeClass } from "../agent-profiles/model-size-class.js";
import { finalizeAgentToolAvailability } from "../agent-tool-availability.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
} from "../code-mode.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import { filterRuntimeCompatibleTools } from "../tool-schema-projection.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../tool-search-protocol.js";
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
  "abortSignal" | "executeTool" | "toolExecutionAllow" | "codeModeSkills"
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
    model?: { contextWindow?: number; modelSizeClass?: ModelSizeClass; parameterCount?: number };
    contextTokenBudget?: number;
    modelToolsEnabled: boolean;
    /** False when the harness cannot dispatch an unregistered catalog name directly. */
    supportsDeferredToolCalls?: boolean;
    prompt?: string;
    runId?: string;
    runtimeToolAllowlist?: readonly string[];
    /** Owner-prepared policy projection for async tool-surface construction. */
    preparedToolOverrideAllowlist?: readonly string[];
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
  // A worker only has presentation config. The gateway already resolved the profile with the
  // operator's agentProfileId, so its compact decision stands instead of a re-selection by size.
  const agentProfile = presentation
    ? resolveAgentProfile({
        config: {
          agents: {
            defaults: {
              agentProfileId: presentation.toolSearchDirectoryLean
                ? "openclaw/small"
                : "openclaw/base",
            },
          },
        },
      })
    : resolveAgentProfile({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        modelSizeClass: resolveProfileModelSizeClass(params.model),
      });
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
          resolvedProfile: agentProfile,
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
  const resolveExplicitToolOverrideNames = () =>
    params.preparedToolOverrideAllowlist
      ? [...params.preparedToolOverrideAllowlist, ...(runtimeToolAllowlist ?? [])]
      : resolveConversationCapabilityProfile({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          modelProvider: params.modelProvider,
          modelId: params.modelId,
          runtimeToolAllowlist,
          scheduledToolPolicy: params.scheduledToolPolicy,
        }).policy.explicitToolOverrideAllowlist;
  const agentProfileFiltersTools = hasCompactToolProfile(agentProfile);
  let runtimeAgentProfilePreserveToolNames: string[] | undefined;
  const preserveAgentProfileTools = () =>
    agentProfileFiltersTools
      ? (runtimeAgentProfilePreserveToolNames ??= resolveAgentProfilePreserveToolNames({
          toolNames: resolveExplicitToolOverrideNames(),
          forceMessageTool: params.forceMessageTool,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        }))
      : undefined;
  const compactTools = (
    tools: AnyAgentTool[],
    options: {
      hookContext?: HookContext;
      agentProfileApplied?: boolean;
      prepared?: PreparedToolSurface;
    } = {},
  ) => {
    const prepared = options.prepared;
    // A worker receives the Gateway's already-projected tools and has only presentation config,
    // so it cannot rebuild the preserve list and must not filter them again. Native harness
    // callers may supply raw tools, while the bundled tool constructor already applied the full
    // prepared policy and must not be filtered a second time.
    const gatewayProjected = presentation !== undefined;
    const preserveToolNames =
      prepared?.preserveToolNames ??
      (options.agentProfileApplied || gatewayProjected ? undefined : preserveAgentProfileTools());
    const projectedProfileTools =
      prepared || options.agentProfileApplied || gatewayProjected
        ? tools
        : filterToolsByAgentProfile({
            tools,
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            resolvedProfile: agentProfile,
            preserveToolNames,
          });
    let effectiveTools = prepared
      ? projectedProfileTools
      : filterRuntimeCompatibleTools(projectedProfileTools).tools;
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
      catalogRef: toolSearchCatalogRef,
      toolHookContext: options.hookContext,
      toolExecutionAllow: prepared?.toolExecutionAllow,
      codeModeSkills,
    });
    const projectedProfileCompactedTools =
      gatewayProjected || (!prepared && options.agentProfileApplied)
        ? compacted.tools
        : filterToolsByAgentProfile({
            tools: compacted.tools,
            config: params.config,
            agentId: params.agentId,
            sessionKey: prepared ? undefined : params.sessionKey,
            resolvedProfile: agentProfile,
            preserveToolNames,
          });
    const schemaProjection = filterRuntimeCompatibleTools(projectedProfileCompactedTools);
    effectiveTools = schemaProjection.tools;
    if (!compacted.catalogRegistered) {
      finalizeAgentToolAvailability(effectiveTools, {
        toolExecutionAllow: prepared?.toolExecutionAllow,
      });
    }
    return {
      tools: effectiveTools,
      catalog: compacted,
      projectedTools: projectedProfileCompactedTools,
      diagnostics: schemaProjection.diagnostics,
      promptToolPolicy: createAgentHarnessPromptToolPolicy({
        diagnosticIdentity: params,
        tools: effectiveTools,
        catalogRef: toolSearchCatalogRef,
        codeModeControlsEnabled,
        catalogPrompt:
          toolSearchControlsEnabled || codeModeControlsEnabled
            ? {
                config: codeModeControlsEnabled ? params.config : toolSearchRuntimeConfig,
                toolSearchDirectoryCompact:
                  presentation?.toolSearchDirectoryLean ?? agentProfileFiltersTools,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
                contextTokenBudget: params.contextTokenBudget ?? params.model?.contextWindow,
              }
            : undefined,
      }),
    };
  };
  return {
    plan,
    agentProfile,
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
