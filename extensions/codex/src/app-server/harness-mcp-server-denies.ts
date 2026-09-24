/**
 * Applies host-certified `<server>__*` denies to the Codex MCP projection by
 * disabling those configured servers, the same override `codex.agents` uses.
 */
import { assignMcpCatalogSafeServerNames } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { resolveCodexMcpToolOverridesForAgent } from "openclaw/plugin-sdk/codex-mcp-projection";
import { resolveCodexNativeMcpServerNamespace } from "./codex-app-tool-names.js";

type CodexMcpToolOverrides = ReturnType<typeof resolveCodexMcpToolOverridesForAgent>;

export function applyHarnessDeniedMcpServerOverrides(
  overrides: CodexMcpToolOverrides,
  deniedServerNames: readonly string[] | undefined,
): CodexMcpToolOverrides {
  if (!deniedServerNames?.length) {
    return overrides;
  }
  const mcpServers = { ...overrides?.mcpServers };
  for (const serverName of deniedServerNames) {
    // Policy denial narrows session overrides; it never re-enables a server.
    mcpServers[serverName] = false;
  }
  return { ...overrides, mcpServers };
}

/**
 * Native Codex config may define a server under the certified deny's raw key or
 * its sanitized alias in any letter case. Returns the inherited names such a deny
 * covers, so the thread config can switch them off explicitly. An inherited
 * server whose model-facing namespace overlaps a whole-app deny (a native
 * `codex_apps__gamma_` entry beside `mcp__codex_apps__gamma_*`) is covered too:
 * the app projection cannot remove that server's tools, so the deny must.
 */
export function resolveDeniedInheritedMcpServerNames(params: {
  inheritedServerNames: readonly string[];
  deniedServerNames: readonly string[] | undefined;
  deniedAppPatterns?: readonly string[];
  configuredServerNames: readonly string[];
}): string[] {
  const deniedServerNames = params.deniedServerNames ?? [];
  const appLiterals = (params.deniedAppPatterns ?? []).map((pattern) =>
    pattern.slice(0, -1).toLowerCase(),
  );
  if (deniedServerNames.length === 0 && appLiterals.length === 0) {
    return [];
  }
  const safeNames = assignMcpCatalogSafeServerNames(params.configuredServerNames);
  const aliases = new Set(
    deniedServerNames.flatMap((name) => [
      name.toLowerCase(),
      (safeNames.get(name) ?? name).toLowerCase(),
    ]),
  );
  return [...new Set(params.inheritedServerNames)]
    .filter((name) => {
      if (aliases.has(name.toLowerCase())) {
        return true;
      }
      const namespace = resolveCodexNativeMcpServerNamespace(name).toLowerCase();
      return appLiterals.some(
        (literal) => namespace.startsWith(literal) || literal.startsWith(namespace),
      );
    })
    .toSorted();
}
