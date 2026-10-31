import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";

// Name sanitizers for tools exposed by bundle MCP servers. Provider/tool names
// must fit model-facing schema limits while remaining stable and collision-free.
const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
export const TOOL_NAME_SEPARATOR = "__";
const TOOL_NAME_MAX_PREFIX = 30;
const TOOL_NAME_MAX_TOTAL = 64;

export function compareMcpCatalogTools(left: McpCatalogTool, right: McpCatalogTool): number {
  return (
    left.safeServerName.localeCompare(right.safeServerName) ||
    left.toolName.localeCompare(right.toolName) ||
    left.serverName.localeCompare(right.serverName)
  );
}

export function mcpCatalogToolsSignature(tools: readonly McpCatalogTool[]): string {
  return JSON.stringify(
    tools.map((tool) => [
      tool.serverName,
      tool.safeServerName,
      tool.toolName,
      tool.title ?? "",
      tool.description ?? "",
      tool.fallbackDescription,
      tool.inputSchema,
      tool.uiResourceUri ?? "",
      tool.uiVisibility ?? null,
    ]),
  );
}

export function sanitizeNodeIdFragment(value: string): string {
  const fragment = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!fragment) {
    return "node";
  }
  return /^[a-z]/.test(fragment) ? fragment : `node_${fragment}`.slice(0, 32);
}

function sanitizeToolFragment(raw: string, fallback: string, maxChars?: number): string {
  const cleaned = raw.trim().replace(TOOL_NAME_SAFE_RE, "-");
  const normalized = cleaned || fallback;
  const providerSafe = /^[A-Za-z]/.test(normalized) ? normalized : `${fallback}-${normalized}`;
  if (!maxChars) {
    return providerSafe;
  }
  return providerSafe.length > maxChars ? providerSafe.slice(0, maxChars) : providerSafe;
}

export function sanitizeServerName(raw: string, usedNames: Set<string>): string {
  const base = sanitizeToolFragment(raw, "mcp", TOOL_NAME_MAX_PREFIX);
  let candidate = base;
  let n = 2;
  while (usedNames.has(normalizeLowercaseStringOrEmpty(candidate))) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_PREFIX - suffix.length))}${suffix}`;
    n += 1;
  }
  usedNames.add(normalizeLowercaseStringOrEmpty(candidate));
  return candidate;
}

/**
 * Assign safe server names from the full declared set in declaration order,
 * independent of which servers resolve for a requester. Declaration order
 * preserves legacy collision-suffix ownership for existing static configs;
 * sorting here would silently swap safe names between colliding servers.
 */
export function assignSafeServerNames(serverNames: Iterable<string>): Map<string, string> {
  const usedNames = new Set<string>();
  const assignments = new Map<string, string>();
  for (const serverName of serverNames) {
    assignments.set(serverName, sanitizeServerName(serverName, usedNames));
  }
  return assignments;
}

export function normalizeReservedToolNames(names?: Iterable<string>): Set<string> {
  return new Set(
    Array.from(names ?? [], (name) => normalizeOptionalLowercaseString(name)).filter(
      (name): name is string => Boolean(name),
    ),
  );
}

/**
 * The name buildSafeToolName tries on a given attempt: attempt 1 is the
 * unsuffixed name, and attempt n >= 2 is the `-n` collision-suffixed name.
 */
export function safeToolNameCandidate(params: {
  serverName: string;
  toolName: string;
  attempt: number;
}): string {
  const maxToolChars = Math.max(
    1,
    TOOL_NAME_MAX_TOTAL - params.serverName.length - TOOL_NAME_SEPARATOR.length,
  );
  const baseToolName =
    sanitizeToolFragment(params.toolName, "tool").slice(0, maxToolChars) || "tool";
  // Keep the suffix inside the total tool-name budget while preserving the
  // server prefix as the namespace boundary.
  const suffix = params.attempt > 1 ? `-${params.attempt}` : "";
  const candidateToolName = suffix
    ? `${baseToolName.slice(0, Math.max(1, maxToolChars - suffix.length))}${suffix}`
    : baseToolName;
  return `${params.serverName}${TOOL_NAME_SEPARATOR}${candidateToolName}`;
}

export function buildSafeToolName(params: {
  serverName: string;
  toolName: string;
  reservedNames: Set<string>;
}): string {
  let attempt = 1;
  let candidate = safeToolNameCandidate({ ...params, attempt });
  while (params.reservedNames.has(normalizeLowercaseStringOrEmpty(candidate))) {
    attempt += 1;
    candidate = safeToolNameCandidate({ ...params, attempt });
  }
  return candidate;
}
