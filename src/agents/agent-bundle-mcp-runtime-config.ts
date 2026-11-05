import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeMcpToolDenials } from "../config/sessions/session-tool-overrides.js";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import {
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
} from "./mcp-connection-resolver.js";
import { createMcpServerToolDenyMatcher } from "./tool-policy-match.js";

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedAgentMcpConfig>;

export function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  loaded?: LoadedMcpConfig;
  logDiagnostics?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  /** Server names whose url/headers must not affect the fingerprint. */
  redactConnectionServerNames?: ReadonlySet<string>;
  /** Full-set safe-name assignments; folded into fingerprint for all partitions. */
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  toolDenylist?: string[];
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
  safeServerNamesByServer: ReadonlyMap<string, string>;
} {
  const loaded =
    params.loaded ??
    loadEmbeddedAgentMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      toolOverrides: params.toolOverrides,
    });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  const safeServerNamesByServer =
    params.safeServerNamesByServer ?? assignSafeServerNames(Object.keys(loaded.mcpServers));
  const safeServerNames =
    safeServerNamesByServer.size === 0
      ? undefined
      : Object.fromEntries(
          [...safeServerNamesByServer.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
        );
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const mcpToolsDeny = normalizeMcpToolDenials(params.toolOverrides?.mcpToolsDeny);
  let mcpServers = loaded.mcpServers;
  const { includeServerNames, excludeServerNames, toolDenylist } = params;
  if (includeServerNames || excludeServerNames || toolDenylist?.length) {
    const filtered: typeof mcpServers = {};
    const isDenied = createMcpServerToolDenyMatcher(toolDenylist);
    for (const [serverName, rawServer] of Object.entries(mcpServers)) {
      if (includeServerNames && !includeServerNames.has(serverName)) {
        continue;
      }
      if (excludeServerNames?.has(serverName)) {
        continue;
      }
      if (isDenied(safeServerNamesByServer.get(serverName) ?? serverName)) {
        continue;
      }
      filtered[serverName] = rawServer;
    }
    mcpServers = filtered;
  }
  const prepareDataDirsByServer = Object.fromEntries(
    Object.entries(loaded.prepareDataDirsByServer ?? {}).filter(([serverName]) =>
      Object.hasOwn(mcpServers, serverName),
    ),
  );
  const fingerprintServers = params.redactConnectionServerNames?.size
    ? redactMcpServersForFingerprint(mcpServers, params.redactConnectionServerNames)
    : mcpServers;
  return {
    safeServerNamesByServer,
    loaded: {
      ...loaded,
      mcpServers,
      // Launch ownership is not serialized or fingerprinted; the injected env path already
      // participates in the server fingerprint and this sidecar only authorizes mkdir.
      prepareDataDirsByServer,
    },
    // This hash only invalidates in-memory catalogs; requester URLs/headers are already redacted.
    fingerprint: sha256Hex(
      JSON.stringify({
        servers: fingerprintServers,
        mcpAppsEnabled,
        ...(safeServerNames ? { safeServerNames } : {}),
        mcpToolsDeny,
      }),
    ),
  };
}

/**
 * Loads enabled MCP config metadata for a session without creating runtimes,
 * connecting transports, or issuing MCP tools/list requests.
 */
export function resolveSessionMcpConfigSummary(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  toolDenylist?: string[];
}): { fingerprint: string; serverNames: string[] } {
  const { loaded, safeServerNamesByServer } = loadSessionMcpConfig({
    ...params,
    logDiagnostics: false,
  });
  const declaredServerNames = Object.keys(loaded.mcpServers);
  const serverNames = declaredServerNames.toSorted((a, b) => a.localeCompare(b));
  // Mirror getOrCreate: the bare-keyed runtime folds full-set safe names into
  // its fingerprint and excludes requester-scoped servers from its partition.
  // Compare apples-to-apples or tools.effective reports stale-config forever.
  const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(loaded.mcpServers);
  const { fingerprint } = loadSessionMcpConfig({
    ...params,
    loaded,
    logDiagnostics: false,
    ...(requesterScopedServerNames.length > 0
      ? { excludeServerNames: new Set(requesterScopedServerNames) }
      : {}),
    safeServerNamesByServer,
  });
  return { fingerprint, serverNames };
}
