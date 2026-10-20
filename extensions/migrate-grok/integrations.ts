import { isDeepStrictEqual } from "node:util";
import {
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
  resolveMigrationConfigRuntime,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { grokPluginSetup, GROK_TOOL_TRANSLATION_NOTE } from "./plugin-equivalents.js";
import type { GrokMcpServer, GrokSourceInventory } from "./source/types.js";
import { grokImportId, type GrokAgentTargets } from "./targets.js";

type IntegrationParams = {
  inventory: GrokSourceInventory;
  ctx: MigrationProviderContext;
  agentTargets: GrokAgentTargets;
};

function manual(
  source: string,
  id: string,
  message: string,
  recommendation: string,
): MigrationItem {
  return createMigrationManualItem({ id, source, message, recommendation });
}

function mcpDefinition(server: GrokMcpServer): Record<string, unknown> | undefined {
  const raw = server.config;
  const command = normalizeOptionalString(raw.command);
  const url = normalizeOptionalString(raw.url);
  if (Boolean(command) === Boolean(url)) {
    return undefined;
  }
  const type = normalizeOptionalString(raw.type) ?? normalizeOptionalString(raw.transport);
  if (type && !["stdio", "http", "sse", "streamable-http"].includes(type)) {
    return undefined;
  }
  if ((command && type && type !== "stdio") || (url && type === "stdio")) {
    return undefined;
  }
  if (url) {
    const parsed = URL.parse(url);
    if (
      !parsed ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      [...parsed.searchParams.keys()].some((key) => /token|key|secret|password|auth/iu.test(key))
    ) {
      return undefined;
    }
  }
  if (
    raw.args !== undefined &&
    (!Array.isArray(raw.args) || !raw.args.every((value) => typeof value === "string"))
  ) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {
    ...(command ? { command, ...(raw.args ? { args: raw.args } : {}) } : { url }),
    transport: command ? "stdio" : type === "sse" ? "sse" : "streamable-http",
    // Grok selects MCP connections per agent. A global native entry cannot preserve that scope.
    enabled: false,
  };
  const cwd = normalizeOptionalString(raw.cwd);
  if (cwd) {
    mapped.cwd = cwd;
  }
  if (server.disabledTools?.length) {
    if (server.disabledTools.some((tool) => !tool.trim() || /[?[*]/u.test(tool))) {
      return undefined;
    }
    mapped.toolFilter = { exclude: server.disabledTools };
  }
  return mapped;
}

export function planGrokIntegrations(params: IntegrationParams): MigrationItem[] {
  const { inventory, ctx } = params;
  const items: MigrationItem[] = [];
  for (const server of inventory.mcpServers.value) {
    const source = `${inventory.source}#mcpServers.${server.name}`;
    const id = grokImportId(`mcp:${server.name}`);
    const value = mcpDefinition(server);
    if (!value || ["__proto__", "constructor", "prototype"].includes(server.name)) {
      items.push(
        manual(
          source,
          `manual:${id}`,
          `MCP server "${server.name}" requires manual translation.`,
          "Review the archived connection definition and create a native MCP connection with the same restrictions.",
        ),
      );
      continue;
    }
    const path = ["mcp", "servers", server.name];
    items.push({
      ...createMigrationConfigPatchItem({
        id: `config:${id}`,
        source,
        target: `mcp.servers.${server.name}`,
        path,
        value,
        conflict:
          !ctx.overwrite &&
          !isDeepStrictEqual(ctx.config.mcp?.servers?.[server.name], value) &&
          hasMigrationConfigPatchConflict(ctx.config, path, value),
        message: `Import MCP connection "${server.name}".`,
        sensitive: server.credentialSelectors.length > 0,
        details: {
          serverName: server.name,
          sourceEnabled: server.enabled ?? null,
          credentialIds: server.credentialSelectors.map((selector) => selector.id).toSorted(),
        },
      }),
      action: "import-mcp",
    });
    items.push(
      manual(
        source,
        `manual:${id}:scope`,
        `MCP connection "${server.name}" is imported disabled because Grok's per-agent scope is not preserved by a global native connection.`,
        "Review the intended agent scope and native tool permissions before enabling this connection.",
      ),
    );
    const unmapped = Object.keys(server.config).filter(
      (key) =>
        ![
          "command",
          "args",
          "url",
          "cwd",
          "type",
          "transport",
          "sourceAuthenticationRequired",
        ].includes(key),
    );
    if (unmapped.length) {
      items.push(
        manual(
          source,
          `manual:${id}:settings`,
          `MCP connection "${server.name}" has source settings without a verified native mapping: ${unmapped.toSorted().join(", ")}.`,
          "Review these settings in the archived source before enabling the connection.",
        ),
      );
    }
    if (server.credentialSelectors.length > 0) {
      items.push(
        manual(
          source,
          `manual:${id}:credentials`,
          `MCP connection "${server.name}" requires credentials configured in OpenClaw; Grok credentials are not copied.`,
          "Configure its environment and headers through native OpenClaw setup before enabling it. --include-secrets does not enable Grok credential copying.",
        ),
      );
    }
    if (server.config.sourceAuthenticationRequired === true) {
      items.push(
        manual(
          source,
          `manual:${id}:oauth`,
          `MCP connection "${server.name}" needs a new authorization in OpenClaw.`,
          "Configure native MCP authentication and sign in again before enabling the connection. Grok OAuth grants are not copied.",
        ),
      );
    }
    if (server.instructions) {
      items.push(
        manual(
          source,
          `manual:${id}:instructions`,
          `Grok-specific instructions for MCP connection "${server.name}" need review.`,
          "Copy the archived connection instructions into the intended agent's instructions after reviewing their scope.",
        ),
      );
    }
  }
  for (const agent of inventory.agents.value) {
    for (const plugin of agent.plugins.value) {
      const equivalent = grokPluginSetup(plugin.pluginId);
      items.push(
        manual(
          `${inventory.source}#agents.${agent.id}.plugins.${plugin.pluginId}`,
          `manual:${grokImportId(`plugin:${agent.id}:${plugin.pluginId}`)}`,
          equivalent
            ? `Grok plugin "${plugin.name}" used by "${agent.name}" has a supported setup path: ${equivalent.name}. Setup and tool compatibility still require verification.`
            : `Grok plugin "${plugin.name}" used by "${agent.name}" has no verified native package mapping.`,
          equivalent
            ? `${equivalent.setup} ${GROK_TOOL_TRANSLATION_NOTE}`
            : "No package is installed by name matching. Identify and verify a native integration, then authorize it separately.",
        ),
      );
    }
  }
  for (const selector of inventory.credentials) {
    items.push(
      manual(
        `${inventory.source}#credentials.${selector.id}`,
        `manual:${grokImportId(`credential:${selector.id}`)}`,
        `Credential "${selector.name}" is not copied; its portability has not been verified.`,
        "Configure credentials through the destination provider or integration setup. --include-secrets does not enable Grok credential copying.",
      ),
    );
  }
  return items;
}

class McpMigrationConflict extends Error {}

async function writeMcpConfig(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  name: string,
  value: Record<string, unknown>,
): Promise<MigrationItem> {
  const api = resolveMigrationConfigRuntime(ctx);
  if (!api) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  if (isDeepStrictEqual(api.current().mcp?.servers?.[name], value)) {
    return { ...item, status: "migrated" };
  }
  try {
    await api.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const existing = draft.mcp?.servers?.[name];
        if (existing && !ctx.overwrite && !isDeepStrictEqual(existing, value)) {
          throw new McpMigrationConflict();
        }
        draft.mcp ??= {};
        draft.mcp.servers ??= {};
        // Replace this reviewed connection; merging would retain obsolete transports or credentials.
        draft.mcp.servers[name] = value;
      },
    });
    return { ...item, status: "migrated" };
  } catch (error) {
    return error instanceof McpMigrationConflict
      ? markMigrationItemConflict(item, "A different MCP connection already exists.")
      : markMigrationItemError(item, "The native config writer rejected the MCP connection.");
  }
}

export async function applyGrokIntegrationItem(
  params: IntegrationParams & {
    item: MigrationItem;
  },
): Promise<MigrationItem> {
  const { ctx, item, inventory } = params;
  if (item.status !== "planned") {
    return item;
  }
  if (item.action === "import-api-key") {
    return markMigrationItemSkipped(
      item,
      "Grok credentials are not copied. Configure credentials in OpenClaw.",
    );
  }
  if (item.action !== "import-mcp") {
    return markMigrationItemError(item, "Unknown Grok integration migration action.");
  }
  const server = inventory.mcpServers.value.find(
    (entry) => entry.name === item.details?.serverName,
  );
  if (
    !server ||
    ["__proto__", "constructor", "prototype"].includes(server.name) ||
    !isRecord(item.details?.value)
  ) {
    return markMigrationItemError(item, "The reviewed MCP connection is no longer available.");
  }
  const definition = mcpDefinition(server);
  if (
    !definition ||
    !isDeepStrictEqual(definition, item.details.value) ||
    !isDeepStrictEqual(
      server.credentialSelectors.map((selector) => selector.id).toSorted(),
      item.details.credentialIds,
    )
  ) {
    return markMigrationItemError(item, "The source MCP connection changed. Review a new plan.");
  }
  if (item.details.includeSecrets === true) {
    return markMigrationItemSkipped(
      item,
      "Grok credentials are not copied. Review a new plan for the connection definition only.",
    );
  }
  return await writeMcpConfig(ctx, item, server.name, definition);
}
