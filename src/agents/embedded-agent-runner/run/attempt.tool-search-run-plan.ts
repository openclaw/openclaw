import { normalizeToolName } from "../../tool-policy.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../../tool-search.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";

export const TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES = [
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];

type CollectAllowedToolNamesParams = Parameters<typeof collectAllowedToolNames>[0];

export type ToolSearchRunPlan = {
  visibleAllowedToolNames: Set<string>;
  replayAllowedToolNames: Set<string>;
  autoAddedControlNames?: Set<string>;
  emptyAllowlistCallableNames: string[];
};

/**
 * Build the names used by the empty-allowlist guard while excluding Tool Search
 * controls that were auto-added only to expose catalog search.
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
 * Identify Tool Search controls that should not satisfy an explicit allowlist
 * because the runtime added them implicitly for catalog access.
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
 * Build the visible/replay tool-name sets for a Tool Search run while keeping
 * compact visible controls separate from the full replay-safe tool universe.
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
        // Replay still needs visible Tool Search controls even when compaction
        // hid the backing catalog entries from the immediate prompt.
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
