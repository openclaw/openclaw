import { normalizeToolName } from "../../tool-policy.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../../tool-search.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";

/**
 * Tool Search control names that can be injected automatically. They are
 * tracked separately from user-visible allowlist entries so validation can still
 * detect an explicit allowlist that would otherwise expose no callable tools.
 */
export const TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES = [
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];

type CollectAllowedToolNamesParams = Parameters<typeof collectAllowedToolNames>[0];

/**
 * Tool Search planning output for one attempt. Visible names describe what the
 * current compacted tool surface exposes; replay names preserve tools from the
 * uncompacted surface so older transcript tool calls can still be recognized.
 */
export type ToolSearchRunPlan = {
  visibleAllowedToolNames: Set<string>;
  replayAllowedToolNames: Set<string>;
  autoAddedControlNames?: Set<string>;
  emptyAllowlistCallableNames: string[];
};

/**
 * Builds the synthetic callable-name list used to reject empty explicit
 * allowlists. Auto-added controls are ignored, but cataloged tools hidden behind
 * Tool Search still count because the model can discover and call them.
 */
export function buildCallableToolNamesForEmptyAllowlistCheck(params: {
  effectiveToolNames: string[];
  autoAddedToolSearchControlNames?: Set<string>;
  toolSearchCatalogToolCount: number;
}): string[] {
  return [
    ...params.effectiveToolNames.filter(
      (toolName) => !params.autoAddedToolSearchControlNames?.has(toolName),
    ),
    ...Array.from(
      { length: params.toolSearchCatalogToolCount },
      (_, index) => `tool-search:${index}`,
    ),
  ];
}

/**
 * Identifies Tool Search controls that were added by the runtime instead of
 * explicitly requested. Those names are removed from the empty-allowlist check
 * so auto-injected discovery controls cannot mask a bad user allowlist.
 */
export function buildAutoAddedToolSearchControlNamesForAllowlistCheck(params: {
  toolSearchControlsEnabled: boolean;
  explicitAllowlistSources: Array<{ entries: string[] }>;
  controlNames?: readonly string[];
}): Set<string> | undefined {
  if (!params.toolSearchControlsEnabled) {
    return undefined;
  }
  const explicitlyAllowed = new Set(
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolName(entry)),
    ),
  );
  return new Set(
    (params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES).filter(
      (controlName) => !explicitlyAllowed.has(normalizeToolName(controlName)),
    ),
  );
}

function collectExplicitlyAllowedClientToolNames(params: {
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): string[] {
  const explicitNames = new Set(
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolName(entry)),
    ),
  );
  return (params.clientTools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name?.trim()))
    .filter((name) => explicitNames.has(normalizeToolName(name)));
}

/**
 * Builds the per-attempt Tool Search plan from visible compacted tools,
 * uncompacted replay tools, client tools, and explicit allowlists. The result
 * keeps model-visible discovery separate from transcript replay compatibility.
 */
export function buildToolSearchRunPlan(params: {
  visibleTools: CollectAllowedToolNamesParams["tools"];
  uncompactedTools: CollectAllowedToolNamesParams["tools"];
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  catalogRegistered: boolean;
  catalogToolCount: number;
  controlsEnabled: boolean;
  controlNames?: readonly string[];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): ToolSearchRunPlan {
  const visibleAllowedToolNames = collectAllowedToolNames({
    tools: params.visibleTools,
    clientTools: params.catalogRegistered ? undefined : params.clientTools,
  });
  const replayAllowedToolNames = collectAllowedToolNames({
    tools: params.uncompactedTools,
    clientTools: params.clientTools,
  });
  if (params.controlsEnabled) {
    for (const controlName of params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES) {
      if (visibleAllowedToolNames.has(controlName)) {
        replayAllowedToolNames.add(controlName);
      }
    }
  }
  const autoAddedControlNames = buildAutoAddedToolSearchControlNamesForAllowlistCheck({
    toolSearchControlsEnabled: params.controlsEnabled,
    explicitAllowlistSources: params.explicitAllowlistSources,
    controlNames: params.controlNames,
  });
  const clientCatalogCallableNames = params.catalogRegistered
    ? collectExplicitlyAllowedClientToolNames({
        clientTools: params.clientTools,
        explicitAllowlistSources: params.explicitAllowlistSources,
      }).map((name) => `tool-search-client:${name}`)
    : [];
  return {
    visibleAllowedToolNames,
    replayAllowedToolNames,
    autoAddedControlNames,
    emptyAllowlistCallableNames: [
      ...buildCallableToolNamesForEmptyAllowlistCheck({
        effectiveToolNames: [...visibleAllowedToolNames],
        autoAddedToolSearchControlNames: autoAddedControlNames,
        toolSearchCatalogToolCount: params.catalogToolCount,
      }),
      ...clientCatalogCallableNames,
    ],
  };
}
