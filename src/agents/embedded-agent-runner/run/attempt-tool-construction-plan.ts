/**
 * Plans which core, bundle MCP, and bundle LSP tools an attempt should build.
 */
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import {
  type CoreToolFactoryFamily,
  type OpenClawCodingToolConstructionPlan,
  resolveCoreToolFactoryFamily,
} from "../../core-tool-factory-descriptors.js";
import { isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import {
  attachToolAllowlistIntersection,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  normalizeToolList,
  normalizeToolName,
  readToolAllowlistIntersection,
} from "../../tool-policy.js";

const ALL_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: true,
  includeShellTools: true,
  includeChannelTools: true,
  includeOpenClawTools: true,
  includePluginTools: true,
};

const NO_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: false,
};

function cloneCodingToolConstructionPlan(
  plan: OpenClawCodingToolConstructionPlan,
): OpenClawCodingToolConstructionPlan {
  return { ...plan };
}

function isBundleMcpAllowlistName(normalized: string): boolean {
  // Bundle MCP tools use the synthetic bundle name or `bundle__tool` separator form.
  return normalized === "bundle-mcp" || normalized.includes(TOOL_NAME_SEPARATOR);
}

function isPluginGroupAllowlistName(normalized: string): boolean {
  return normalized === "group:plugins";
}

function hasWildcardToolAllowlist(toolsAllow: string[]): boolean {
  return toolsAllow.some((entry) => normalizeToolName(entry) === "*");
}

/**
 * Applies a runtime allowlist to a concrete tool list after expanding tool and
 * plugin groups. Undefined allowlists keep all tools; an explicit empty list
 * intentionally disables all runtime tools.
 */
export function applyEmbeddedAttemptToolsAllow<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
  options?: {
    toolMeta?: (tool: T) => { pluginId: string } | undefined;
  },
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow) ?? [toolsAllow];
  return restrictions.reduce<T[]>((currentTools, restriction) => {
    if (restriction.length === 0) {
      return [];
    }
    if (hasWildcardToolAllowlist(restriction)) {
      return currentTools;
    }
    const pluginGroups = options?.toolMeta
      ? buildPluginToolGroups({ tools: currentTools, toolMeta: options.toolMeta })
      : undefined;
    const policy = pluginGroups
      ? expandPolicyWithPluginGroups({ allow: restriction }, pluginGroups)
      : { allow: restriction };
    return currentTools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
  }, tools);
}

/**
 * Adds host-required tools to a narrowed runtime allowlist. Wildcard and
 * undefined allowlists already cover every required tool.
 */
export function mergeForcedEmbeddedAttemptToolsAllow(
  toolsAllow: string[] | undefined,
  params: { forceMessageTool?: boolean; forceToolNames?: readonly string[] },
): string[] | undefined {
  if (toolsAllow === undefined || hasWildcardToolAllowlist(toolsAllow)) {
    return toolsAllow;
  }
  const required = [
    ...(params.forceMessageTool ? ["message"] : []),
    ...(params.forceToolNames ?? []),
  ];
  if (required.length === 0) {
    return toolsAllow;
  }
  const normalized = new Set(toolsAllow.map((entry) => normalizeToolName(entry)));
  const missing = required.filter((name) => !normalized.has(normalizeToolName(name)));
  if (missing.length === 0) {
    return toolsAllow;
  }
  const restrictions = readToolAllowlistIntersection(toolsAllow);
  const merged = [...toolsAllow, ...missing];
  return restrictions
    ? attachToolAllowlistIntersection(
        merged,
        restrictions.map((restriction) => restriction.concat(missing)),
      )
    : merged;
}

function resolveCodingToolConstructionPlanForAllowlist(
  toolsAllow?: string[],
): OpenClawCodingToolConstructionPlan {
  if (!toolsAllow) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (toolsAllow.length === 0) {
    return cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (hasWildcardToolAllowlist(toolsAllow)) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  const expanded = expandToolGroups(toolsAllow);
  const normalized = normalizeToolList(expanded);
  const coreFamilies = new Set<CoreToolFactoryFamily>();
  let includePluginTools = false;
  for (const name of normalized) {
    const family = resolveCoreToolFactoryFamily(name);
    if (family) {
      coreFamilies.add(family);
      continue;
    }
    // Plugin ids/tool names are not known to the local factory catalog.
    if (!isBundleMcpAllowlistName(name)) {
      includePluginTools = true;
    }
  }
  const includeBaseCodingTools = coreFamilies.has("base-coding");
  const includeShellTools = coreFamilies.has("shell");
  const includeOpenClawTools = coreFamilies.has("openclaw");
  // Channel delivery tools are constructed through plugin-capable runtime setup.
  const includeChannelTools = includePluginTools;

  return {
    includeBaseCodingTools,
    includeShellTools,
    includeChannelTools,
    includeOpenClawTools,
    includePluginTools,
  };
}

/**
 * Decides which tool families need to be constructed for an embedded attempt.
 * This keeps allowlisted plugin/channel tools available without forcing every
 * local core tool factory to run for narrow plugin-only configurations.
 */
export function resolveEmbeddedAttemptToolConstructionPlan(params: {
  disableTools?: boolean;
  isRawModelRun?: boolean;
  toolsEnabled?: boolean;
  toolsAllow?: string[];
  forceMessageTool?: boolean;
}): {
  constructTools: boolean;
  includeCoreTools: boolean;
  runtimeToolAllowlist?: string[];
  codingToolConstructionPlan: OpenClawCodingToolConstructionPlan;
} {
  // Model capability is authoritative: forced delivery cannot materialize a
  // tool the selected model cannot call.
  if (
    params.disableTools === true ||
    params.isRawModelRun === true ||
    params.toolsEnabled === false
  ) {
    return {
      constructTools: false,
      includeCoreTools: false,
      codingToolConstructionPlan: cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN),
    };
  }
  const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
  });
  const codingToolConstructionPlan = resolveCodingToolConstructionPlanForAllowlist(toolsAllow);
  const includeCoreTools =
    codingToolConstructionPlan.includeBaseCodingTools ||
    codingToolConstructionPlan.includeShellTools ||
    codingToolConstructionPlan.includeOpenClawTools;
  const constructTools =
    includeCoreTools ||
    codingToolConstructionPlan.includeChannelTools ||
    codingToolConstructionPlan.includePluginTools;

  return {
    constructTools,
    includeCoreTools,
    ...(toolsAllow ? { runtimeToolAllowlist: toolsAllow } : {}),
    codingToolConstructionPlan,
  };
}

function shouldCreateBundleRuntimeForAttempt(
  params: {
    toolsEnabled: boolean;
    disableTools?: boolean;
    toolsAllow?: string[];
  },
  matchesAllowlist: (normalizedToolName: string) => boolean,
): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow) {
    return true;
  }
  if (params.toolsAllow.length === 0) {
    return false;
  }
  if (hasWildcardToolAllowlist(params.toolsAllow)) {
    return true;
  }
  return params.toolsAllow.some((toolName) => matchesAllowlist(normalizeToolName(toolName)));
}

/**
 * Decides whether the bundled MCP runtime is needed for this attempt. Bundle
 * runtime creation follows explicit bundle/plugin allowlist names rather than
 * generic local tool names.
 */
/**
 * MCP server names that should participate in materialization prechecks.
 * Mirrors effective enablement: session `toolOverrides.mcpServers[name] === true`
 * enables a server even when config has `enabled: false`.
 */
export function listMaterializableMcpServerNames(params: {
  servers?: Record<string, { enabled?: boolean } | null | undefined> | null;
  toolOverrides?: { mcpServers?: Record<string, boolean> };
}): string[] {
  const servers = params.servers ?? {};
  const overrides = params.toolOverrides?.mcpServers;
  const names: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (!server) {
      continue;
    }
    const override = overrides && Object.hasOwn(overrides, name) ? overrides[name] : undefined;
    if (override === false) {
      continue;
    }
    if (override === true || server.enabled !== false) {
      names.push(name);
    }
  }
  return names;
}

/**
 * True when an allowlist entry names a configured MCP server (or a server-name
 * glob like `hzr-oa*`) even without the `server__tool` separator. Without this,
 * narrow cron `toolsAllow: ["hzr-oa*"]` skips MCP materialization and fails with
 * an empty callable tool set.
 */
function matchesConfiguredMcpServerAllowlist(
  normalized: string,
  mcpServerNames?: Iterable<string>,
): boolean {
  if (!mcpServerNames) {
    return false;
  }
  const usedNames = new Set<string>();
  for (const serverName of mcpServerNames) {
    const safeName = normalizeToolName(sanitizeServerName(serverName, usedNames));
    if (!safeName) {
      continue;
    }
    if (
      normalized === safeName ||
      normalized === `${safeName}*` ||
      normalized.startsWith(`${safeName}${TOOL_NAME_SEPARATOR}`) ||
      (normalized.endsWith("*") &&
        normalized.length > 1 &&
        safeName.startsWith(normalized.slice(0, -1)))
    ) {
      return true;
    }
  }
  return false;
}

export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  /** Enabled `mcp.servers` keys from OpenClaw config (owner-managed MCP). */
  mcpServerNames?: Iterable<string>;
}): boolean {
  return shouldCreateBundleRuntimeForAttempt(params, (normalized) => {
    return (
      isBundleMcpAllowlistName(normalized) ||
      isPluginGroupAllowlistName(normalized) ||
      matchesConfiguredMcpServerAllowlist(normalized, params.mcpServerNames)
    );
  });
}

/**
 * Decides whether the bundled LSP runtime is needed for this attempt. LSP tools
 * are enabled by default/wildcard and by allowlist entries with the `lsp_`
 * prefix.
 */
export function shouldCreateBundleLspRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  return shouldCreateBundleRuntimeForAttempt(params, (normalized) => {
    return normalized.startsWith("lsp_");
  });
}
