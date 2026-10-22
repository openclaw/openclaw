import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import {
  isCodeModeDiagnosticEnabled,
  logCodeModeDiagnostic,
} from "../../../logging/code-mode-diagnostic.js";
import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { resolveSkillWorkshopToolConstructionBlock } from "../../../skills/workshop/tool-availability.js";
import {
  finalizeAgentToolAvailability,
  gateAgentToolExecution,
} from "../../agent-tool-availability.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../../code-mode.js";
import { logAgentRuntimeToolDiagnostics } from "../../runtime-plan/tools.js";
import { createToolPolicyMatcher, isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import {
  createToolExecutionMatcher,
  formatToolExecutionGatedMessage,
} from "../../tool-policy-shared.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import {
  withRuntimeToolSchemaQuarantine,
  type RuntimeToolSchemaQuarantineRecorder,
} from "../../tool-schema-quarantine.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../../tool-search-types.js";
import {
  collectUniqueCatalogToolNames,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { log } from "../logger.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedToolBase = Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>>;
type PreparedBundleTools = Awaited<ReturnType<typeof prepareEmbeddedAttemptBundleTools>>;

function hasExplicitlyAllowedClientTool(params: {
  clientTools?: PreparedBundleTools["clientTools"];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): boolean {
  const names = (params.clientTools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name?.trim()));
  if (names.length === 0) {
    return false;
  }
  const matchers = params.explicitAllowlistSources.map((source) =>
    createToolPolicyMatcher({ allow: source.entries }),
  );
  return names.some((name) => matchers.some((matches) => matches(name)));
}

export async function prepareEmbeddedAttemptToolCatalog(input: {
  attempt: EmbeddedRunAttemptParams;
  setup: EmbeddedAttemptSetup;
  preparedToolBase: PreparedToolBase;
  bundleTools: Pick<PreparedBundleTools, "clientTools" | "uncompactedEffectiveTools">;
  abortSignal: AbortSignal;
  executeCodeModeTool: ToolSearchCatalogToolExecutor;
}) {
  const buildCatalog = (recordQuarantine: RuntimeToolSchemaQuarantineRecorder) => {
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
    // tool hidden behind dispatch_action/exec is gated too; the catalog controls stay
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
    recordQuarantine({
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
      emitTrustedDiagnosticEvent({
        type: "tool.catalog",
        source: "builtin",
        mode: codeModeControlsEnabledForRun ? "code-mode" : "tool-search",
        toolCount: toolSearch.catalogToolCount,
      });
    }
    const deferredDirectoryToolsCallable =
      toolSearchControlsEnabledForRun &&
      toolSearchConfig.mode === "directory" &&
      toolSearch.catalogRegistered;
    // Use the same resolved policy that constructed and filtered the run's tools.
    const {
      agentId,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      sandboxPolicy,
      subagentPolicy,
      inheritedToolPolicy,
    } = runtimeCapabilityProfile.policy;
    const agentToolLabel = agentId ? `agents.${agentId}.tools` : "agent tools";
    const explicitToolAllowlistSources = [
      { label: "tools.allow", allow: globalPolicy?.allow },
      { label: "tools.byProvider.allow", allow: globalProviderPolicy?.allow },
      { label: `${agentToolLabel}.allow`, allow: agentPolicy?.allow },
      { label: `${agentToolLabel}.byProvider.allow`, allow: agentProviderPolicy?.allow },
      { label: "group tools.allow", allow: groupPolicy?.allow },
      { label: "sandbox tools.allow", allow: sandboxPolicy?.allow },
      { label: "subagent tools.allow", allow: subagentPolicy?.allow },
      { label: "inherited tools.allow", allow: inheritedToolPolicy?.allow },
      { label: "runtime toolsAllow", allow: attempt.toolsAllow, enforceWhenToolsDisabled: true },
    ].flatMap(({ label, allow, enforceWhenToolsDisabled }) => {
      const entries = normalizeStringEntries(allow);
      return entries.length === 0 ? [] : [{ label, entries, enforceWhenToolsDisabled }];
    });
    const clientToolsCataloged =
      toolSearch.catalogRegistered &&
      (codeModeControlsEnabledForRun || toolSearchConfig.mode !== "directory");
    const controlsEnabled = toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun;
    const controlNames = codeModeControlsEnabledForRun
      ? [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME]
      : toolSearchConfig.mode === "directory"
        ? [TOOL_SEARCH_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME, TOOL_CALL_RAW_TOOL_NAME]
        : [...TOOL_SEARCH_CONTROL_TOOL_NAMES];
    // Visible tools use compacted prompt state; replay keeps uncompacted identities.
    const visibleAllowedToolNames = collectAllowedToolNames({
      tools: effectiveTools,
      clientTools: clientToolsCataloged ? undefined : clientTools,
    });
    const replayAllowedToolNames = collectAllowedToolNames({
      tools: uncompactedEffectiveTools,
      clientTools,
    });
    const capabilityToolNames = collectAllowedToolNames({
      tools: [
        ...(deferredDirectoryToolsCallable ? uncompactedEffectiveTools : effectiveTools),
        ...(toolSearch.catalogRegistered ? uncompactedEffectiveTools : []),
      ].filter((tool) => getPluginToolMeta(tool)?.pluginId !== "bundle-mcp"),
    });
    if (controlsEnabled) {
      // Visible compacted controls must remain allowed during uncompacted replay.
      for (const controlName of controlNames) {
        if (visibleAllowedToolNames.has(controlName)) {
          replayAllowedToolNames.add(controlName);
        }
      }
    }
    const liveAllowedToolNames = deferredDirectoryToolsCallable
      ? collectUniqueCatalogToolNames(uncompactedEffectiveTools)
      : visibleAllowedToolNames;
    if (deferredDirectoryToolsCallable) {
      // Hidden Tool Search controls are not deferred catalog entries.
      for (const controlName of TOOL_SEARCH_CONTROL_TOOL_NAMES) {
        if (!visibleAllowedToolNames.has(controlName)) {
          liveAllowedToolNames.delete(controlName);
          capabilityToolNames.delete(controlName);
        }
      }
      for (const visibleName of visibleAllowedToolNames) {
        liveAllowedToolNames.add(visibleName);
      }
    }
    const explicitControlAllowlistNames = new Set(
      explicitToolAllowlistSources.flatMap((source) =>
        source.entries.map((entry) => normalizeToolPolicyName(entry)),
      ),
    );
    const autoAddedControlNames = new Set(
      (controlsEnabled ? controlNames : []).filter(
        (controlName) => !explicitControlAllowlistNames.has(normalizeToolPolicyName(controlName)),
      ),
    );
    const explicitlyAllowedClientTool = hasExplicitlyAllowedClientTool({
      clientTools,
      explicitAllowlistSources: explicitToolAllowlistSources,
    });
    const emptyAllowlistVisibleToolNames = deferredDirectoryToolsCallable
      ? collectAllowedToolNames({ tools: effectiveTools })
      : visibleAllowedToolNames;
    // Auto-added controls cannot conceal an explicit allowlist that matched nothing.
    const hasCallableTools =
      toolSearch.catalogToolCount > 0 ||
      ((clientToolsCataloged || deferredDirectoryToolsCallable) && explicitlyAllowedClientTool) ||
      [...emptyAllowlistVisibleToolNames].some((toolName) => !autoAddedControlNames.has(toolName));
    const toolSearchRunPlan = {
      visibleAllowedToolNames,
      replayAllowedToolNames,
      liveAllowedToolNames,
      capabilityToolNames,
      hasCallableTools,
    };
    const emptyExplicitToolAllowlistError = (() => {
      if (attempt.forceRestartSafeTools) {
        return null;
      }
      const toolsIntentionallyDisabled =
        attempt.disableTools === true || preparedToolBase.effectiveToolsAllow?.length === 0;
      const sources = toolsIntentionallyDisabled
        ? explicitToolAllowlistSources.filter((source) => source.enforceWhenToolsDisabled === true)
        : explicitToolAllowlistSources;
      if (sources.length === 0 || hasCallableTools) {
        return null;
      }
      const requested = sources
        .map(
          (source) => `${source.label}: ${source.entries.map(normalizeToolPolicyName).join(", ")}`,
        )
        .join("; ");
      const workshopBlock = sources.every((source) =>
        isToolAllowedByPolicyName("skill_workshop", { allow: source.entries }),
      )
        ? resolveSkillWorkshopToolConstructionBlock({
            sandboxed: input.setup.sandbox?.enabled,
            libraryAuthoring: attempt.skillLibraryAuthoring,
          })
        : undefined;
      if (toolsEnabled && !toolsIntentionallyDisabled && workshopBlock) {
        return new Error(
          `No callable tools remain after resolving explicit tool allowlist (${requested}); ${workshopBlock.detail} ${workshopBlock.fix}`,
        );
      }
      const reason =
        attempt.disableTools === true
          ? "tools are disabled for this run"
          : toolsEnabled
            ? "no registered tools matched"
            : "the selected model does not support tools";
      return new Error(
        `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
      );
    })();
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
  const current = await withRuntimeToolSchemaQuarantine(buildCatalog);
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
    refreshTools: (recordQuarantine: RuntimeToolSchemaQuarantineRecorder) => {
      const next = buildCatalog(recordQuarantine);
      current.effectiveTools.splice(0, current.effectiveTools.length, ...next.effectiveTools);
      for (const key of [...promptPlanKeys, "replayAllowedToolNames"] as const) {
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
      : gateAgentToolExecution(tool, formatToolExecutionGatedMessage(tool.name, allowNames)),
  );
}
