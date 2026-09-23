/**
 * Classifies deny entries in a harness's native app tool namespace, such as
 * `mcp__codex_apps__<app>_*`, that the harness enforces against its own app
 * projection instead of isolating the native tool surface.
 */
import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import { partitionMcpServersByConnectionScope } from "../mcp-connection-resolver.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";

/**
 * True for `<prefix><literal>*` where `<literal>` holds no further glob syntax
 * (`*` or `?`). `<literal>` may be empty (deny every native app).
 */
export function isHarnessNativeAppDenyPattern(
  normalizedName: string,
  normalizedPrefix: string,
): boolean {
  if (!normalizedName.startsWith(normalizedPrefix) || !normalizedName.endsWith("*")) {
    return false;
  }
  return !/[*?]/.test(normalizedName.slice(normalizedPrefix.length, -1));
}

export function normalizeHarnessNativeAppDenyPrefix(
  prefix: string | undefined,
): string | undefined {
  const normalized = prefix?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * Model-facing namespaces the harness gives configured static MCP servers,
 * `<mcp prefix><server>__`, where `<mcp prefix>` is the leading segment of the
 * native app prefix (`mcp__` for `mcp__codex_apps__`). Server keys are lowercased
 * and every character outside `[a-z0-9_]` becomes `_`, which over-approximates
 * the harness's own sanitizer so an overlap is never missed. A key that already
 * starts with the MCP prefix keeps it, as Codex does, instead of gaining a second.
 */
export function resolveHarnessNativeAppDenyReservedNamespaces(
  config: OpenClawConfig | undefined,
  normalizedPrefix: string | undefined,
): string[] {
  if (!normalizedPrefix) {
    return [];
  }
  const separatorIndex = normalizedPrefix.indexOf(TOOL_NAME_SEPARATOR);
  const mcpPrefix =
    separatorIndex === -1
      ? ""
      : normalizedPrefix.slice(0, separatorIndex + TOOL_NAME_SEPARATOR.length);
  const configured = normalizeConfiguredMcpServers(config?.mcp?.servers);
  const { staticServers } = partitionMcpServersByConnectionScope(configured);
  const namespaces = Object.keys(staticServers).map((serverName) => {
    const sanitized = serverName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const prefixed = sanitized.startsWith(mcpPrefix) ? sanitized : `${mcpPrefix}${sanitized}`;
    return `${prefixed}${TOOL_NAME_SEPARATOR}`;
  });
  return [...new Set(namespaces)].toSorted();
}

/**
 * True when a native-app deny could also match a configured MCP server's tools,
 * for example `mcp__codex_apps__gamma_*` beside a server named `codex_apps`.
 * The app projection cannot enforce that part of the deny, so such a pattern
 * must keep isolating the native surface.
 */
export function harnessNativeAppDenyOverlapsMcpServer(
  normalizedName: string,
  reservedNamespaces: readonly string[],
): boolean {
  const literal = normalizedName.slice(0, -1);
  return reservedNamespaces.some(
    (namespace) => namespace.startsWith(literal) || literal.startsWith(namespace),
  );
}

/** Sorted unique native-app deny patterns present in any of the given policies. */
export function collectHarnessDeniedNativeAppPatterns(
  policies: ReadonlyArray<{ allow?: string[]; deny?: string[] } | undefined>,
  normalizedPrefix: string | undefined,
): string[] {
  if (!normalizedPrefix) {
    return [];
  }
  const patterns = new Set<string>();
  for (const policy of policies) {
    for (const deniedName of expandToolGroups(policy?.deny ?? [])) {
      const normalized = normalizeToolPolicyName(deniedName);
      if (isHarnessNativeAppDenyPattern(normalized, normalizedPrefix)) {
        patterns.add(normalized);
      }
    }
  }
  return [...patterns].toSorted();
}
