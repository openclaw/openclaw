// Memory Core plugin module implements dreaming command behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/config-runtime";
import { resolveMemoryDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { asRecord } from "./dreaming-shared.js";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";

function updateDreamingEnabledInConfig(
  cfg: OpenClawConfig,
  agentId: string,
  enabled: boolean,
): OpenClawConfig | null {
  const agentList = [...(cfg.agents?.list ?? [])];
  const agentIndex = agentList.findIndex(
    (entry) => normalizeAgentId(entry?.id) === normalizeAgentId(agentId),
  );
  const isDefaultAgent = normalizeAgentId(agentId) === normalizeAgentId(resolveDefaultAgentId(cfg));
  if (agentIndex < 0 && (agentList.length > 0 || !isDefaultAgent)) {
    return null;
  }
  const existingAgentMemory =
    agentIndex >= 0 ? (agentList[agentIndex]?.memory ?? {}) : (cfg.memory ?? {});
  const extensions = { ...existingAgentMemory.extensions };
  const memoryCore = asRecord(extensions["memory-core"]) ?? {};
  const dreaming = asRecord(memoryCore.dreaming) ?? {};
  extensions["memory-core"] = {
    ...memoryCore,
    dreaming: {
      ...dreaming,
      enabled,
    },
  };
  const memory = { ...existingAgentMemory, extensions };

  if (agentIndex >= 0) {
    agentList[agentIndex] = { ...agentList[agentIndex], memory };
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        list: agentList,
      },
    };
  }
  return {
    ...cfg,
    memory,
  };
}

function formatEnabled(value: boolean): string {
  return value ? "on" : "off";
}

function formatPhaseGuide(): string {
  return [
    "- implementation detail: each sweep runs light -> REM -> deep.",
    "- deep is the only stage that writes durable entries to MEMORY.md.",
    "- DREAMS.md is for human-readable dreaming summaries and diary entries.",
  ].join("\n");
}

function formatStatus(cfg: OpenClawConfig, agentId: string): string {
  const dreaming = resolveMemoryDreamingConfig({
    cfg,
    agentId,
  });
  const deep = resolveShortTermPromotionDreamingConfig({ cfg, agentId });
  const timezone = dreaming.timezone ? ` (${dreaming.timezone})` : "";

  return [
    "Dreaming status:",
    `- enabled: ${formatEnabled(dreaming.enabled)}${timezone}`,
    `- sweep cadence: ${dreaming.frequency}`,
    `- promotion policy: score>=${deep.minScore}, recalls>=${deep.minRecallCount}, uniqueQueries>=${deep.minUniqueQueries}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /dreaming status",
    "Usage: /dreaming on|off",
    "",
    includeStatus,
    "",
    "Phases:",
    formatPhaseGuide(),
  ].join("\n");
}

function requiresAdminToMutateDreaming(gatewayClientScopes?: readonly string[]): boolean {
  return Array.isArray(gatewayClientScopes) && !gatewayClientScopes.includes("operator.admin");
}

export async function handleDreamingCommand(api: OpenClawPluginApi, ctx: PluginCommandContext) {
  const args = ctx.args?.trim() ?? "";
  const [firstToken = ""] = args
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => normalizeLowercaseStringOrEmpty(token));
  const currentConfig = api.runtime.config.current() as OpenClawConfig;
  const agentId = normalizeAgentId(
    ctx.agentId ??
      parseAgentSessionKey(ctx.sessionKey)?.agentId ??
      resolveDefaultAgentId(currentConfig),
  );

  if (!firstToken || firstToken === "help" || firstToken === "options" || firstToken === "phases") {
    return { text: formatUsage(formatStatus(currentConfig, agentId)) };
  }

  if (firstToken === "status") {
    return { text: formatStatus(currentConfig, agentId) };
  }

  if (firstToken === "on" || firstToken === "off") {
    if (requiresAdminToMutateDreaming(ctx.gatewayClientScopes)) {
      return { text: "⚠️ /dreaming on|off requires operator.admin for gateway clients." };
    }
    const enabled = firstToken === "on";
    if (!updateDreamingEnabledInConfig(currentConfig, agentId, enabled)) {
      return { text: `Dreaming config cannot be changed for unknown agent "${agentId}".` };
    }
    const committed = await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const nextConfig = updateDreamingEnabledInConfig(draft, agentId, enabled);
        if (!nextConfig) {
          throw new Error(`Dreaming config target disappeared: ${agentId}`);
        }
        Object.assign(draft, nextConfig);
      },
    });
    return {
      text: [
        `Dreaming ${enabled ? "enabled" : "disabled"}.`,
        "",
        formatStatus(committed.nextConfig, agentId),
      ].join("\n"),
    };
  }

  return { text: formatUsage(formatStatus(currentConfig, agentId)) };
}

export function registerDreamingCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "dreaming",
    description: "Enable or disable memory dreaming.",
    acceptsArgs: true,
    handler: async (ctx) => await handleDreamingCommand(api, ctx),
  });
}
