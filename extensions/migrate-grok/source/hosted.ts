import { resolveGrokBotAvatarDefaults } from "./avatar.js";
import { object, records, text } from "./files.js";
import { applyMcpSettings, complete, mcpServers, safeSettings, unavailable } from "./normalize.js";
import { GrokSourceHttpError, readGrokResponse } from "./transport.js";
import type { GrokSourceAgent, GrokSourceInventory, GrokSourceSection } from "./types.js";

export async function requestGrok(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  dashboard = false,
): Promise<Record<string, unknown>> {
  const response = await readGrokResponse(
    `https://api2.cursor.sh/aiserver.v1.${dashboard ? "DashboardService" : "GrokBotService"}/${method}`,
    { token, body },
  );
  try {
    const value = object(JSON.parse(response));
    if (value) {
      return value;
    }
  } catch {
    // Never quote source JSON in diagnostics.
  }
  throw new Error("Grok returned an invalid source response.");
}

function failure(method: string, error: unknown): string {
  return `${method} was unavailable${error instanceof GrokSourceHttpError ? ` (HTTP ${error.status})` : ""}. Check Grok account access or supply a complete migration snapshot.`;
}

export async function readHostedInventory(
  inventory: GrokSourceInventory,
  resolveToken: () => Promise<string>,
): Promise<void> {
  let token: string;
  try {
    token = await resolveToken();
  } catch {
    inventory.issues.push({
      code: "source_auth_unavailable",
      message:
        "Grok sign-in could not be read. Sign in to Grok Bot and unlock its native credential storage, or provide GROK_BOT_ACCESS_TOKEN for this migration.",
    });
    return;
  }
  inventory.issues.push({
    code: "source_cloud_credentials_unavailable",
    message:
      "Grok cloud vault passwords and connected service OAuth sessions are not available as portable credentials. Credentials are not copied; configure the destination integrations separately.",
  });
  const read = (method: string, body: Record<string, unknown> = {}, dashboard = false) =>
    requestGrok(token, method, body, dashboard);
  const section = async <T>(
    method: string,
    fallback: T,
    operation: () => Promise<T>,
    agentId?: string,
  ): Promise<GrokSourceSection<T>> => {
    try {
      return complete(await operation());
    } catch (error) {
      const reason = failure(method, error);
      inventory.issues.push({
        code: "source_section_unavailable",
        message: reason,
        ...(agentId ? { agentId } : {}),
      });
      return unavailable(fallback, reason);
    }
  };
  const [runtime, mcpSettings, permissions] = await Promise.all([
    section(
      "GetGrokBotUserRuntimeSettings",
      {},
      async () => object((await read("GetGrokBotUserRuntimeSettings")).settings) ?? {},
    ),
    section(
      "GetGrokBotUserMcpSettings",
      {},
      async () => object((await read("GetGrokBotUserMcpSettings")).settings) ?? {},
    ),
    section("GetGrokBotMcpToolPermissions", {}, () => read("GetGrokBotMcpToolPermissions")),
  ]);
  const local = inventory.settings;
  inventory.settings = {
    status: [local, runtime, mcpSettings, permissions].every(
      (value) => value.status === "unavailable",
    )
      ? "unavailable"
      : runtime.status === "complete" &&
          mcpSettings.status === "complete" &&
          permissions.status === "complete"
        ? "complete"
        : "partial",
    value: safeSettings({
      ...local.value,
      ...runtime.value,
      ...mcpSettings.value,
      mcpToolPermissions: permissions.value,
    }),
    ...(runtime.status !== "complete" ||
    mcpSettings.status !== "complete" ||
    permissions.status !== "complete"
      ? {
          reason:
            "Some hosted account settings were unavailable; available local settings were retained.",
        }
      : {}),
  };
  inventory.mainAgentId = text(inventory.settings.value.mainAgentId);
  inventory.mcpServers = await section("GetMcpConfig", [], async () => {
    const reply = await read(
      "GetMcpConfig",
      { teamScope: false, redactSecrets: true, expandPluginVariables: true },
      true,
    );
    if (typeof reply.configJson !== "string") {
      throw new Error("MCP configuration was not returned.");
    }
    const servers = mcpServers(JSON.parse(reply.configJson), "grok-api:mcp", true);
    applyMcpSettings(servers, inventory.settings.value, reply.serverMetadataByName);
    return servers;
  });
  const availableServers = await section("GetAvailableMcpServers", [], async () =>
    records((await read("GetAvailableMcpServers", {}, true)).servers),
  );
  for (const row of availableServers.value) {
    const server = inventory.mcpServers.value.find((entry) => entry.name === row.name);
    if (server && typeof row.enabled === "boolean") {
      server.enabled = row.enabled;
    }
    if (
      row.userHasAccessToken === true ||
      row.credentialIsCursorAccount === true ||
      row.grokConnectorId ||
      row.mergeConnectorId
    ) {
      if (server) {
        server.config.sourceAuthenticationRequired = true;
        server.credentialSelectors = [];
      }
      inventory.issues.push({
        code: "oauth_reconnection_required",
        message: `Connected Grok services require destination sign-in; source OAuth sessions are not portable.`,
      });
    }
  }
  if (availableServers.status !== "complete" && inventory.mcpServers.status === "complete") {
    inventory.mcpServers.status = "partial";
    inventory.mcpServers.reason =
      "MCP connection authentication metadata was unavailable; reconnect before enabling these servers.";
    for (const server of inventory.mcpServers.value) {
      server.config.sourceAuthenticationRequired = true;
      server.credentialSelectors = [];
    }
  }
  inventory.credentials.push(
    ...inventory.mcpServers.value.flatMap((server) => server.credentialSelectors),
  );
  const roster = await section("ListGrokBotAgents", [], async () => {
    const response = await read("ListGrokBotAgents");
    if (response.truncated === true || response.nextPageToken) {
      throw new Error("Grok returned a truncated roster.");
    }
    return records(response.agents).filter(
      (agent) =>
        (agent.kind === 1 || agent.kind === "GROK_BOT_AGENT_KIND_AGENT") &&
        (agent.visibility === 1 || agent.visibility === "GROK_BOT_AGENT_VISIBILITY_OWNER") &&
        agent.viewerIsOwner !== false,
    );
  });
  if (roster.status !== "complete") {
    inventory.agents = unavailable([], roster.reason!);
    return;
  }
  const agents: GrokSourceAgent[] = [];
  const ids = roster.value.map((row) => text(row.agentId));
  if (new Set(ids).size !== ids.length) {
    inventory.agents = unavailable(
      [],
      "Grok returned duplicate agent IDs; migration requires an unambiguous inventory.",
    );
    inventory.issues.push({ code: "duplicate_agent_ids", message: inventory.agents.reason! });
    return;
  }
  for (const row of roster.value) {
    const id = text(row.agentId);
    const name = text(row.name);
    if (!id || !name) {
      inventory.issues.push({
        code: "invalid_agent_identity",
        message: "A hosted bot did not provide a valid runtime ID and name.",
      });
      continue;
    }
    const agent: GrokSourceAgent = {
      id,
      name,
      instructions: text(row.description) ?? "",
      title: text(row.title),
      memory: unavailable(
        [],
        "Private cloud memory is not imported because complete export support is unverified. Supply a complete recipe or snapshot to import exported memory.",
      ),
      skills: unavailable([], "Skills were not read."),
      automations: unavailable([], "Automations were not read."),
      plugins: unavailable([], "Plugin requirements were not read."),
    };
    const defaults = resolveGrokBotAvatarDefaults({
      id,
      avatarShape: text(row.avatarShape),
      avatarColor: text(row.avatarColor),
    });
    agent.avatar = { shape: defaults.avatarShape, color: defaults.avatarColor };
    const avatarUrl = text(row.avatarUrl);
    if (avatarUrl) {
      const image = await section<NonNullable<GrokSourceAgent["avatar"]>["image"]>(
        "avatar_download",
        undefined,
        async () => {
          const { fetchRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
          const media = await fetchRemoteMedia({
            url: avatarUrl,
            maxBytes: 1024 * 1024,
            requireHttps: true,
            maxRedirects: 0,
            timeoutMs: 30_000,
          });
          const extension =
            media.contentType === "image/png"
              ? "png"
              : media.contentType === "image/jpeg"
                ? "jpg"
                : media.contentType === "image/gif"
                  ? "gif"
                  : media.contentType === "image/webp"
                    ? "webp"
                    : undefined;
          if (!extension) {
            throw new Error("Unsupported avatar image.");
          }
          return { bytes: media.buffer, extension };
        },
        id,
      );
      agent.avatar.image = image.value;
    }
    [agent.skills, agent.automations, agent.plugins] = await Promise.all([
      section(
        "ListGrokBotAgentSkills",
        [],
        async () =>
          records((await read("ListGrokBotAgentSkills", { agentId: id })).skills).map((skill) => {
            if (typeof skill.name !== "string" || typeof skill.body !== "string") {
              throw new Error("Invalid source skill.");
            }
            return {
              name: skill.name,
              description: text(skill.description) ?? "",
              content: skill.body,
            };
          }),
        id,
      ),
      section(
        "ListGrokBotAgentAutomations",
        [],
        async () =>
          records(
            (
              await read("ListGrokBotAgentAutomations", {
                agentId: id,
                ...(text(
                  inventory.settings.value.userTimeZoneOverride ??
                    inventory.settings.value.userTimeZone,
                )
                  ? {
                      timeZone:
                        inventory.settings.value.userTimeZoneOverride ??
                        inventory.settings.value.userTimeZone,
                    }
                  : {}),
              })
            ).automations,
          ).map((automation) => {
            const record =
              typeof automation.recordJson === "string"
                ? object(JSON.parse(automation.recordJson))
                : undefined;
            const automationId = text(automation.automationId);
            if (!record || !automationId) {
              throw new Error("Invalid source automation.");
            }
            return { id: automationId, name: text(record.name) ?? automationId, record };
          }),
        id,
      ),
      section(
        "GetGrokBotAgentPlugins",
        [],
        async () => {
          const response = await read("GetGrokBotAgentPlugins", {
            agentId: id,
            includeMcpConfig: false,
          });
          if (response.plugins === undefined) {
            throw new Error("Installed plugin metadata was not returned.");
          }
          return records(response.plugins).map((plugin) => {
            const pluginId = text(plugin.pluginId),
              pluginName = text(plugin.displayName ?? plugin.name);
            if (!pluginId || !pluginName) {
              throw new Error("Invalid plugin metadata.");
            }
            return { pluginId, name: pluginName, description: text(plugin.description) };
          });
        },
        id,
      ),
    ]);
    if (agent.plugins.status === "complete") {
      agent.plugins.status = "partial";
      agent.plugins.reason =
        "Installed plugin metadata does not prove complete original integration requirements.";
    }
    agents.push(agent);
  }
  inventory.agents = {
    status: agents.length === roster.value.length ? "complete" : "partial",
    value: agents,
  };
  if (agents.length) {
    inventory.issues.push({
      code: "source_memory_unavailable",
      message:
        "Private cloud memory was not requested. Only complete memory included in a supplied recipe or snapshot is imported.",
    });
  }
}
