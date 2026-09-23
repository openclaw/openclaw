import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { createToolPolicyMatcher } from "../../tool-policy-match.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";
import { TOOL_SEARCH_CONTROL_TOOL_NAMES } from "../../tool-search-types.js";
import { collectUniqueCatalogToolNames } from "../../tool-search.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";

type CollectAllowedToolNamesParams = Parameters<typeof collectAllowedToolNames>[0];

/** Derived tool allowlists used for visible prompt tools, replay tools, and empty-allowlist checks. */
type ToolSearchRunPlan = {
  visibleAllowedToolNames: Set<string>;
  replayAllowedToolNames: Set<string>;
  liveAllowedToolNames: Set<string>;
  capabilityToolNames: Set<string>;
  hasCallableTools: boolean;
};

function hasExplicitlyAllowedClientTool(params: {
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
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

function collectOpenClawCapabilityToolNames(
  tools: CollectAllowedToolNamesParams["tools"],
): Set<string> {
  return collectAllowedToolNames({
    tools: tools.filter((tool) => getPluginToolMeta(tool)?.pluginId !== "bundle-mcp"),
  });
}

/**
 * Builds the complete tool-search allowlist plan for one run. Visible tools use
 * compacted prompt state, while replay tools use uncompacted state.
 */
export function buildToolSearchRunPlan(params: {
  visibleTools: CollectAllowedToolNamesParams["tools"];
  uncompactedTools: CollectAllowedToolNamesParams["tools"];
  /** Registered catalog capabilities; this does not grant direct execution. */
  catalogCapabilityTools?: CollectAllowedToolNamesParams["tools"];
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  clientToolsCataloged: boolean;
  catalogToolCount: number;
  controlsEnabled: boolean;
  deferredToolsCallable?: boolean;
  controlNames?: readonly string[];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): ToolSearchRunPlan {
  const controlNames = params.controlNames ?? [...TOOL_SEARCH_CONTROL_TOOL_NAMES];
  const visibleAllowedToolNames = collectAllowedToolNames({
    tools: params.visibleTools,
    clientTools: params.clientToolsCataloged ? undefined : params.clientTools,
  });
  const replayAllowedToolNames = collectAllowedToolNames({
    tools: params.uncompactedTools,
    clientTools: params.clientTools,
  });
  const capabilityToolNames = collectOpenClawCapabilityToolNames([
    ...(params.deferredToolsCallable ? params.uncompactedTools : params.visibleTools),
    ...(params.catalogCapabilityTools ?? []),
  ]);
  if (params.controlsEnabled) {
    // A control that was visible in the compacted prompt must remain allowed
    // during replay even when the uncompacted tool set would otherwise omit it.
    for (const controlName of controlNames) {
      if (visibleAllowedToolNames.has(controlName)) {
        replayAllowedToolNames.add(controlName);
      }
    }
  }
  const liveAllowedToolNames = params.deferredToolsCallable
    ? collectUniqueCatalogToolNames(params.uncompactedTools)
    : visibleAllowedToolNames;
  if (params.deferredToolsCallable) {
    // Deferred resolution can hydrate catalog tools, but Tool Search controls
    // excluded from the visible surface are not catalog entries.
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
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolPolicyName(entry)),
    ),
  );
  const autoAddedControlNames = new Set(
    (params.controlsEnabled ? controlNames : []).filter(
      (controlName) => !explicitControlAllowlistNames.has(normalizeToolPolicyName(controlName)),
    ),
  );
  const explicitlyAllowedClientTool = hasExplicitlyAllowedClientTool({
    clientTools: params.clientTools,
    explicitAllowlistSources: params.explicitAllowlistSources,
  });
  const emptyAllowlistVisibleToolNames = params.deferredToolsCallable
    ? collectAllowedToolNames({ tools: params.visibleTools })
    : visibleAllowedToolNames;
  // The guard needs presence, not catalog-sized synthetic names. Auto-added
  // controls alone must not conceal an explicit allowlist that matched nothing.
  let hasCallableTools =
    params.catalogToolCount > 0 ||
    ((params.clientToolsCataloged || params.deferredToolsCallable === true) &&
      explicitlyAllowedClientTool);
  for (const toolName of emptyAllowlistVisibleToolNames) {
    if (!autoAddedControlNames.has(toolName)) {
      hasCallableTools = true;
      break;
    }
  }
  return {
    visibleAllowedToolNames,
    replayAllowedToolNames,
    liveAllowedToolNames,
    capabilityToolNames,
    hasCallableTools,
  };
}
