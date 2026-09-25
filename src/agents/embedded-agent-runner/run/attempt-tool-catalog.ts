import {
  isCodeModeDiagnosticEnabled,
  logCodeModeDiagnostic,
} from "../../../logging/code-mode-diagnostic.js";
import {
  copyAgentToolAvailability,
  finalizeAgentToolAvailability,
  markAgentToolExecutionUnavailable,
} from "../../agent-tool-availability.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../../code-mode.js";
import { logAgentRuntimeToolDiagnostics } from "../../runtime-plan/tools.js";
import { buildEmptyExplicitToolAllowlistError } from "../../tool-allowlist-guard.js";
import {
  createToolExecutionMatcher,
  TOOL_EXECUTION_GATED_MESSAGE,
} from "../../tool-policy-shared.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../../tool-search-types.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import { collectAttemptExplicitToolAllowlistSources } from "./attempt-tool-allowlist.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import { buildToolSearchRunPlan } from "./attempt-tool-search-run-plan.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedToolBase = Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>>;
type PreparedBundleTools = Awaited<ReturnType<typeof prepareEmbeddedAttemptBundleTools>>;

export function prepareEmbeddedAttemptToolCatalog(input: {
  attempt: EmbeddedRunAttemptParams;
  setup: EmbeddedAttemptSetup;
  preparedToolBase: PreparedToolBase;
  bundleTools: Pick<PreparedBundleTools, "clientTools" | "uncompactedEffectiveTools">;
  abortSignal: AbortSignal;
  executeCodeModeTool: ToolSearchCatalogToolExecutor;
}) {
  const buildCatalog = () => {
    const { attempt, preparedToolBase } = input;
    const {
      codeModeControlsEnabledForRun,
      codeModeSkills,
      localModelLeanPreserveToolNames,
      runtimeCapabilityProfile,
      toolSearchConfig,
      toolSearchControlsEnabledForRun,
      toolsEnabled,
    } = preparedToolBase;
    const { clientTools, uncompactedEffectiveTools } = input.bundleTools;
    const abortSignal = preparedToolBase.toolAbortSignal ?? input.abortSignal;
    // Detached skill review keeps every foreground schema for prompt-cache reuse
    // but executes only the allowed tools. Wrap before catalog compaction so a
    // tool hidden behind tool_call/exec is gated too; the catalog controls stay
    // callable because they only dispatch into the gated tools.
    let effectiveTools = attempt.toolExecutionAllow
      ? gateToolExecution(uncompactedEffectiveTools, attempt.toolExecutionAllow)
      : uncompactedEffectiveTools;
    const catalogToolHookContext = preparedToolBase.toolHookContext;
    const compacted = preparedToolBase.toolSurfaceRuntime.compactTools(effectiveTools, {
      hookContext: catalogToolHookContext,
      prepared: {
        abortSignal,
        forceRestartSafeTools: attempt.forceRestartSafeTools,
        toolExecutionAllow: attempt.toolExecutionAllow,
        executeTool: input.executeCodeModeTool,
        codeModeSkills,
        preserveToolNames: localModelLeanPreserveToolNames,
      },
    });
    const toolSearch = compacted.catalog;
    logRuntimeToolSchemaQuarantine({
      diagnostics: compacted.diagnostics,
      tools: compacted.projectedTools,
      runId: attempt.runId,
      agentId: input.setup.sessionAgentId,
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
    });
    effectiveTools = compacted.tools.map((tool) =>
      wrapEmbeddedAttemptToolWithActivity(
        wrapToolWithAbortSignal(tool, abortSignal),
        attempt.runId,
      ),
    );
    if (codeModeControlsEnabledForRun && isCodeModeDiagnosticEnabled()) {
      logCodeModeDiagnostic(log, "final-surface", {
        runId: attempt.runId,
        fallbackActive: attempt.fallbackActive === true,
        catalogToolCount: toolSearch.catalogToolCount,
        visibleToolNames: effectiveTools.map((tool) => tool.name),
      });
    }
    if (toolSearch.compacted && !toolSearch.catalogReused) {
      log.info(
        codeModeControlsEnabledForRun
          ? `code-mode: cataloged ${toolSearch.catalogToolCount} tools behind exec/wait`
          : toolSearchConfig.mode === "directory"
            ? `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact directory surface`
            : `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact prompt surface`,
      );
    }
    const deferredDirectoryToolsCallable =
      toolSearchControlsEnabledForRun &&
      toolSearchConfig.mode === "directory" &&
      toolSearch.catalogRegistered;
    const explicitToolAllowlistSources = collectAttemptExplicitToolAllowlistSources({
      capabilityProfile: runtimeCapabilityProfile,
      toolsAllow: attempt.toolsAllow,
      toolsAllowIsDefault: attempt.toolsAllowIsDefault,
    });
    const toolSearchRunPlan = buildToolSearchRunPlan({
      visibleTools: effectiveTools,
      uncompactedTools: uncompactedEffectiveTools,
      catalogCapabilityTools: toolSearch.catalogRegistered ? uncompactedEffectiveTools : undefined,
      clientTools,
      clientToolsCataloged:
        toolSearch.catalogRegistered &&
        (codeModeControlsEnabledForRun || toolSearchConfig.mode !== "directory"),
      catalogToolCount: toolSearch.catalogToolCount,
      controlsEnabled: toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun,
      deferredToolsCallable: deferredDirectoryToolsCallable,
      controlNames: codeModeControlsEnabledForRun
        ? [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME]
        : toolSearchConfig.mode === "directory"
          ? [TOOL_SEARCH_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME, TOOL_CALL_RAW_TOOL_NAME]
          : undefined,
      explicitAllowlistSources: explicitToolAllowlistSources,
    });
    const emptyExplicitToolAllowlistError = attempt.forceRestartSafeTools
      ? null
      : buildEmptyExplicitToolAllowlistError({
          sources: explicitToolAllowlistSources,
          hasCallableTools: toolSearchRunPlan.hasCallableTools,
          toolsEnabled,
          disableTools: attempt.disableTools,
          toolsAllowExplicitlyEmpty: preparedToolBase.effectiveToolsAllow?.length === 0,
          scheduledToolPolicyMode: attempt.scheduledToolPolicy?.mode,
          skillWorkshop: {
            sandboxed: input.setup.sandbox?.enabled,
            libraryAuthoring: attempt.skillLibraryAuthoring,
          },
        });
    logAgentRuntimeToolDiagnostics({
      runtimePlan: attempt.runtimePlan,
      tools: effectiveTools,
      provider: attempt.provider,
      config: attempt.config,
      workspaceDir: input.setup.effectiveWorkspace,
      env: process.env,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      model: attempt.model,
      runtimeHandle: input.setup.getProviderRuntimeHandle(),
    });

    return {
      catalogToolHookContext,
      deferredDirectoryToolsCallable,
      effectiveTools,
      emptyExplicitToolAllowlistError,
      toolSearch,
      toolSearchRunPlan,
    };
  };
  const current = buildCatalog();
  const promptPlanKeys = [
    "visibleAllowedToolNames",
    "liveAllowedToolNames",
    "capabilityToolNames",
  ] as const;
  const hostPromptPlan = {
    visibleAllowedToolNames: new Set(current.toolSearchRunPlan.visibleAllowedToolNames),
    liveAllowedToolNames: new Set(current.toolSearchRunPlan.liveAllowedToolNames),
    capabilityToolNames: new Set(current.toolSearchRunPlan.capabilityToolNames),
  };
  return Object.assign(current, {
    applyPromptToolPolicy: (allowedNames: ReadonlySet<string>) => {
      if (!current.toolSearch.catalogRegistered) {
        finalizeAgentToolAvailability(current.effectiveTools, {
          toolExecutionAllow: [...allowedNames],
        });
      }
      for (const key of promptPlanKeys) {
        const names = current.toolSearchRunPlan[key];
        names.clear();
        for (const name of hostPromptPlan[key]) {
          if (allowedNames.has(name)) {
            names.add(name);
          }
        }
      }
    },
    refreshTools: () => {
      const next = buildCatalog();
      current.effectiveTools.splice(0, current.effectiveTools.length, ...next.effectiveTools);
      for (const key of [
        "visibleAllowedToolNames",
        "liveAllowedToolNames",
        "capabilityToolNames",
        "replayAllowedToolNames",
      ] as const) {
        const target = current.toolSearchRunPlan[key];
        // Earlier tool calls remain valid history, even after their live authority is revoked.
        if (key !== "replayAllowedToolNames") {
          target.clear();
        }
        for (const name of next.toolSearchRunPlan[key]) {
          target.add(name);
        }
      }
      Object.assign(current.toolSearch, next.toolSearch);
      for (const key of promptPlanKeys) {
        hostPromptPlan[key] = new Set(next.toolSearchRunPlan[key]);
      }
      current.emptyExplicitToolAllowlistError = next.emptyExplicitToolAllowlistError;
      current.toolSearchRunPlan.hasCallableTools = next.toolSearchRunPlan.hasCallableTools;
    },
  });
}

function gateToolExecution(
  tools: readonly AnyAgentTool[],
  allowNames: readonly string[],
): AnyAgentTool[] {
  const executionAllowed = createToolExecutionMatcher(allowNames);
  return tools.map((tool) =>
    executionAllowed(tool.name) || TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)
      ? tool
      : markAgentToolExecutionUnavailable(
          copyAgentToolAvailability(tool, {
            ...tool,
            // Preparation can perform work too; a denied call must not enter the source path.
            prepareArguments: undefined,
            prepareBeforeToolCallParams: undefined,
            finalizeBeforeToolCallParams: undefined,
            execute: async () => {
              throw new Error(TOOL_EXECUTION_GATED_MESSAGE);
            },
          }),
        ),
  );
}
