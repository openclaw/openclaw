import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
/**
 * Codex CLI and app-server bundle MCP projection helpers.
 */
import { sanitizeServerName, TOOL_NAME_SEPARATOR } from "../agent-bundle-mcp-names.js";
import { buildCodexMcpServersConfig, normalizeCodexMcpServerConfig } from "../codex-mcp-config.js";
import { normalizeToolName } from "../tool-policy-shared.js";
import { isRecord } from "./bundle-mcp-adapter-shared.js";
import { serializeTomlInlineValue } from "./toml-inline.js";

// Mutable JSON shape structurally compatible with the bundled Codex
// app-server thread-config JsonObject (see the protocol module in the codex
// plugin). Defined locally so this projection result stays assignable to
// mergeCodexThreadConfigs without pulling plugin-local types across the
// extensions boundary.
type CodexThreadConfigValue =
  | string
  | number
  | boolean
  | null
  | CodexThreadConfigValue[]
  | { [key: string]: CodexThreadConfigValue };
type CodexThreadConfigObject = { [key: string]: CodexThreadConfigValue };

type CodexUserMcpServersProjectionOptions = {
  agentId?: string;
  /**
   * Effective OpenClaw tool allowlist for the turn (`tools.allow` / `tools.alsoAllow`,
   * already merged). When provided, only MCP servers with at least one permitted tool
   * are projected. When `undefined`, the allowlist imposes no restriction and every
   * enabled server is projected (legacy unrestricted behavior).
   */
  toolsAllow?: string[];
};

/** Allowlist tokens that grant every MCP server (and all of its tools). */
function isGlobalMcpAllowToken(token: string): boolean {
  // Mirrors the bundle-MCP allowlist contract in tool-policy.ts: a literal
  // wildcard, the `bundle-mcp` plugin entry, and the `group:plugins` group all
  // mean "every user MCP server".
  return token === "*" || token === "bundle-mcp" || token === "group:plugins";
}

/**
 * Resolves whether a configured MCP server is permitted by the effective tool
 * allowlist, and which of its tools are in scope.
 *
 * Matching uses the **provider-safe** model-facing tool ids OpenClaw actually
 * exposes — `<sanitizedServer>__<sanitizedTool>` (see `agent-bundle-mcp-names`),
 * not the raw `mcp.servers` config key. `safeServerName` must therefore be the
 * output of `sanitizeServerName` for the server. Rules over normalized tokens:
 *   - allowlist `undefined`               -> include, all tools (no restriction)
 *   - `*` / `bundle-mcp` / `group:plugins`-> include, all tools
 *   - `<safeServer>__*`                   -> include, all tools of that server
 *   - `<safeServer>__<tool>`              -> include, scoped to the named tool(s)
 *   - no matching token                   -> exclude the server
 *
 * `toolNames` (the tool fragment after the `<server>__` prefix) is returned for
 * the scoped case so the projection can emit Codex `enabled_tools`. It is
 * `undefined` when all of the server's tools are in scope.
 */
export function resolveCodexMcpServerAllow(
  safeServerName: string,
  toolsAllow: string[] | undefined,
): { include: boolean; toolNames?: string[] } {
  if (toolsAllow === undefined) {
    return { include: true };
  }
  const prefix = normalizeToolName(`${safeServerName}${TOOL_NAME_SEPARATOR}`);
  const scopedTools: string[] = [];
  for (const raw of toolsAllow) {
    const token = normalizeToolName(raw);
    if (!token) {
      continue;
    }
    if (isGlobalMcpAllowToken(token)) {
      return { include: true };
    }
    if (token.length <= prefix.length || !token.startsWith(prefix)) {
      continue;
    }
    const toolPart = token.slice(prefix.length);
    if (toolPart === "*") {
      return { include: true };
    }
    scopedTools.push(toolPart);
  }
  if (scopedTools.length === 0) {
    return { include: false };
  }
  return { include: true, toolNames: [...new Set(scopedTools)] };
}

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => isValidAgentId(entry))
    .map((entry) => normalizeAgentId(entry));
}

function readCodexProjectionConfig(server: BundleMcpServerConfig): Record<string, unknown> {
  return isRecord(server.codex) ? server.codex : {};
}

function isCodexMcpServerAllowedForAgent(
  server: BundleMcpServerConfig,
  options: CodexUserMcpServersProjectionOptions | undefined,
): boolean {
  const codex = readCodexProjectionConfig(server);
  if (!Object.hasOwn(codex, "agents")) {
    return true;
  }
  const agentIds = normalizeAgentIds(codex.agents);
  if (agentIds.length === 0 || !options?.agentId) {
    return false;
  }
  return agentIds.includes(normalizeAgentId(options.agentId));
}

/** Returns Codex CLI args with TOML MCP server overrides injected. */
export function injectCodexMcpConfigArgs(
  args: string[] | undefined,
  config: BundleMcpConfig,
): string[] {
  const overrides = serializeTomlInlineValue(buildCodexMcpServersConfig(config));
  return [...(args ?? []), "-c", `mcp_servers=${overrides}`];
}

/**
 * Codex app-server runtime (extensions/codex) receives its thread config as a
 * JSON object through JSON-RPC `thread/start`/`thread/resume`, not as `-c` CLI
 * args. This returns a thread-config patch projecting user-configured
 * `cfg.mcp.servers` entries into Codex's `mcp_servers` table using the same
 * per-server normalization the CLI path uses, so app-server agents see the
 * same user MCP servers the CLI runtime exposes via `injectCodexMcpConfigArgs`.
 *
 * Only user-configured servers (`cfg.mcp.servers`) are projected. Plugin-
 * curated app-server apps are already attached separately through the codex
 * plugin thread-config `apps` patch, so they must not be re-projected here.
 */
export function buildCodexUserMcpServersThreadConfigPatch(
  cfg: OpenClawConfig | undefined,
  options?: CodexUserMcpServersProjectionOptions,
): { mcp_servers: CodexThreadConfigObject } | undefined {
  const userServers = normalizeConfiguredMcpServers(cfg?.mcp?.servers);
  const entries = Object.entries(userServers);
  if (entries.length === 0) {
    return undefined;
  }
  const mcp_servers: CodexThreadConfigObject = {};
  // Reserve sanitized names only for servers that are actually exposed, in config
  // order — disabled and agent-scoped-out servers must NOT reserve a name, or a
  // dropped server could shift a later server's collision suffix and break an
  // otherwise-valid `<server>__*` allowlist match. Mirrors how the live tool-id
  // generation (and tool-policy's prefix contract) only names exposed servers.
  const usedNames = new Set<string>();
  for (const [name, server] of entries) {
    if (server.enabled === false) {
      continue;
    }
    if (!isCodexMcpServerAllowedForAgent(server as BundleMcpServerConfig, options)) {
      continue;
    }
    const safeServerName = sanitizeServerName(name, usedNames);
    // Only project servers the effective tool allowlist actually references, so a
    // scoped allowlist (e.g. ["opik__*"]) attaches opik but not other configured
    // servers. Without this, every enabled server was attached regardless of the
    // allowlist, over-exposing tools the operator never granted.
    const allow = resolveCodexMcpServerAllow(safeServerName, options?.toolsAllow);
    if (!allow.include) {
      continue;
    }
    const projected = normalizeCodexMcpServerConfig(
      name,
      server as BundleMcpServerConfig,
    ) as CodexThreadConfigObject;
    if (allow.toolNames && allow.toolNames.length > 0) {
      // Exact `<server>__<tool>` allowlist entries scope the attached server to
      // those tools via Codex's per-server `enabled_tools` filter, so other tools
      // from the same server stay unreachable. The tool fragment comes from the
      // (sanitized, lowercased) allowlist token; this is exact for provider-safe
      // tool names and fails closed (tool simply not enabled) otherwise.
      projected.enabled_tools = [...allow.toolNames];
    }
    mcp_servers[name] = projected;
  }
  if (Object.keys(mcp_servers).length === 0) {
    return undefined;
  }
  return { mcp_servers };
}
