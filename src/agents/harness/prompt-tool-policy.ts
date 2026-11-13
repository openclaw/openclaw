import { createHash } from "node:crypto";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { rememberBoundedKey } from "../../infra/dedupe.js";
import { logWarn } from "../../logger.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  finalizeAgentToolAvailability,
  isAgentToolExecutionAvailable,
} from "../agent-tool-availability.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../code-mode-control-tools.js";
import { buildCodeModeCatalogPrompt } from "../code-mode.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../tool-search-protocol.js";
import {
  buildToolSchemaDirectoryPrompt,
  restrictToolSearchCatalog,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
} from "../tool-search.js";
import type { ToolUsageRankingSnapshot } from "../tool-usage-ranking.js";
import type { AnyAgentTool } from "../tools/common.js";

type NamedTool = { name: string };
type CatalogDiagnosticIdentity = { agentId?: string; sessionKey?: string; sessionId?: string };
// Prompt policy is turn-owned. Keep bounded fingerprints, never executable objects;
// FIFO eviction or process restart may repeat a previously seen warning.
const largeCatalogWarnings = new Set<string>();

function warnLargeCatalog(
  tools: readonly NamedTool[],
  identity?: CatalogDiagnosticIdentity,
  entries: readonly ToolSearchCatalogEntry[] = [],
) {
  if (tools.length + entries.length <= 64 || (!identity?.sessionKey && !identity?.sessionId)) {
    return;
  }
  const callableEntries = entries.filter((entry) => isAgentToolExecutionAvailable(entry.tool));
  const directCatalogNames = new Set(
    callableEntries.filter((entry) => entry.directVisible).map((entry) => entry.name),
  );
  const toolIds = [
    ...new Set([
      ...callableEntries.map((entry) => entry.id),
      ...tools
        .filter((tool) => isAgentToolExecutionAvailable(tool) && !directCatalogNames.has(tool.name))
        .map((tool) => `direct:${tool.name}`),
    ]),
  ].toSorted();
  if (toolIds.length <= 64) {
    return;
  }
  const key = createHash("sha256")
    .update(JSON.stringify([identity.agentId, identity.sessionKey, identity.sessionId, toolIds]))
    .digest("hex");
  if (rememberBoundedKey(largeCatalogWarnings, key, 256)) {
    logWarn(
      `tools: effective session tool catalog contains ${toolIds.length} tools ` +
        `(agent=${identity.agentId ?? "unknown"}); exceeds the advisory 64-tool threshold. ` +
        "This is not the provider-advertised tool count: Code Mode and deferred discovery may expose fewer definitions. No tools were removed.",
    );
  }
}

function isAgentTool<T extends NamedTool>(tool: T): tool is T & AnyAgentTool {
  return "execute" in tool && typeof tool.execute === "function";
}

function filterTools<T extends NamedTool>(
  tools: readonly T[],
  toolsAllow?: string[],
  toolMeta: (tool: T) => { pluginId: string } | undefined = (tool) =>
    isAgentTool(tool) ? getPluginToolMeta(tool) : undefined,
): T[] {
  return toolsAllow === undefined
    ? [...tools]
    : applyEmbeddedAttemptToolsAllow([...tools], toolsAllow, { toolMeta });
}

export function createAgentHarnessPromptToolPolicy<T extends NamedTool>(params: {
  diagnosticIdentity?: CatalogDiagnosticIdentity;
  tools: readonly T[];
  catalogRef?: ToolSearchCatalogRef;
  catalogEntries?: readonly ToolSearchCatalogEntry[];
  codeModeControlsEnabled: boolean;
  catalogPrompt?: {
    config?: OpenClawConfig;
    agentId?: string;
    sessionKey?: string;
    contextTokenBudget?: number;
    toolSearchDirectoryLean?: boolean;
    usageRanking?: ToolUsageRankingSnapshot;
  };
}) {
  const baselineTools = [...params.tools];
  const currentCatalog = params.catalogRef?.current;
  const catalog =
    currentCatalog && params.catalogRef
      ? {
          ref: params.catalogRef,
          entries: [...(params.catalogEntries ?? currentCatalog.entries)],
          directOnlyToolNames: params.catalogRef.baselineDirectOnlyToolNames,
          controlNames: params.codeModeControlsEnabled
            ? new Set([CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME])
            : TOOL_SEARCH_CONTROL_TOOL_NAMES,
        }
      : undefined;
  return {
    apply: (input: { toolsAllow?: string[]; forceToolNames?: readonly string[] } = {}) => {
      const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(input.toolsAllow, {
        forceToolNames: input.forceToolNames,
      });
      const allowedTools = filterTools(baselineTools, toolsAllow);
      if (!catalog) {
        finalizeAgentToolAvailability(allowedTools.filter(isAgentTool));
        warnLargeCatalog(allowedTools, params.diagnosticIdentity);
        return {
          tools: allowedTools,
          toolSchemaDirectoryPrompt: undefined,
          callableToolNames: normalizeUniqueStringEntries(allowedTools.map((tool) => tool.name)),
        };
      }
      const allowedEntries = filterTools(catalog.entries, toolsAllow, (entry) =>
        isAgentTool(entry.tool) ? getPluginToolMeta(entry.tool) : undefined,
      );
      const catalogCount = restrictToolSearchCatalog({
        catalogRef: catalog.ref,
        allowedToolNames: new Set(allowedEntries.map((entry) => entry.name)),
        allowedDirectToolNames: new Set(allowedTools.map((tool) => tool.name)),
        baselineEntries: allowedEntries,
      });
      const allowedNames = new Set(allowedTools.map((tool) => normalizeToolPolicyName(tool.name)));
      const tools = baselineTools.filter((tool) => {
        const name = normalizeToolPolicyName(tool.name);
        return allowedNames.has(name) || (catalogCount > 0 && catalog.controlNames.has(name));
      });
      catalog.ref.directOnlyToolNames = new Set(
        tools
          .filter((tool) => catalog.directOnlyToolNames?.has(tool.name))
          .map((tool) => tool.name),
      );
      const catalogReachable =
        catalogCount > 0 &&
        tools.some((tool) => catalog.controlNames.has(normalizeToolPolicyName(tool.name)));
      // Offered controls preserve the prompt prefix even when this turn cannot execute them.
      const diagnosticCatalogReachable =
        catalogReachable &&
        tools.some(
          (tool) =>
            catalog.controlNames.has(normalizeToolPolicyName(tool.name)) &&
            isAgentToolExecutionAvailable(tool),
        );
      warnLargeCatalog(
        diagnosticCatalogReachable
          ? tools.filter((tool) => !catalog.controlNames.has(normalizeToolPolicyName(tool.name)))
          : tools,
        params.diagnosticIdentity,
        diagnosticCatalogReachable ? allowedEntries : [],
      );
      return {
        tools,
        toolSchemaDirectoryPrompt:
          catalogReachable && params.catalogPrompt
            ? params.codeModeControlsEnabled
              ? buildCodeModeCatalogPrompt(
                  { ...params.catalogPrompt, catalogRef: catalog.ref },
                  catalog.ref.current?.entries ?? [],
                  params.catalogPrompt.usageRanking,
                )
              : buildToolSchemaDirectoryPrompt(
                  { ...params.catalogPrompt, catalogRef: catalog.ref },
                  {
                    contextTokenBudget: params.catalogPrompt.contextTokenBudget,
                    toolSearchDirectoryLean: params.catalogPrompt.toolSearchDirectoryLean,
                    usageRanking: params.catalogPrompt.usageRanking,
                  },
                )
            : undefined,
        callableToolNames: normalizeUniqueStringEntries([
          ...tools.map((tool) => tool.name),
          ...(catalogReachable ? allowedEntries.map((entry) => entry.name) : []),
        ]),
      };
    },
  };
}
