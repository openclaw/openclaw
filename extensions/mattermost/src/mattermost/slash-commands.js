const DEFAULT_COMMAND_SPECS = [
  {
    trigger: "oc_status",
    originalName: "status",
    description: "Show session status (model, usage, uptime)",
    autoComplete: true
  },
  {
    trigger: "oc_model",
    originalName: "model",
    description: "View or change the current model",
    autoComplete: true,
    autoCompleteHint: "[model-name]"
  },
  {
    trigger: "oc_models",
    originalName: "models",
    description: "Browse available models",
    autoComplete: true,
    autoCompleteHint: "[provider]"
  },
  {
    trigger: "oc_new",
    originalName: "new",
    description: "Start a new conversation session",
    autoComplete: true
  },
  {
    trigger: "oc_help",
    originalName: "help",
    description: "Show available commands",
    autoComplete: true
  },
  {
    trigger: "oc_think",
    originalName: "think",
    description: "Set thinking/reasoning level",
    autoComplete: true,
    autoCompleteHint: "[off|low|medium|high]"
  },
  {
    trigger: "oc_reasoning",
    originalName: "reasoning",
    description: "Toggle reasoning mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]"
  },
  {
    trigger: "oc_verbose",
    originalName: "verbose",
    description: "Toggle verbose mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]"
  }
];
async function listMattermostCommands(client, teamId) {
  return await client.request(
    `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`
  );
}
async function createMattermostCommand(client, params) {
  return await client.request("/commands", {
    method: "POST",
    body: JSON.stringify(params)
  });
}
async function deleteMattermostCommand(client, commandId) {
  await client.request(`/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE"
  });
}
async function updateMattermostCommand(client, params) {
  return await client.request(
    `/commands/${encodeURIComponent(params.id)}`,
    {
      method: "PUT",
      body: JSON.stringify(params)
    }
  );
}
async function registerSlashCommands(params) {
  const { client, teamId, creatorUserId, callbackUrl, commands, log } = params;
  const normalizedCreatorUserId = creatorUserId.trim();
  if (!normalizedCreatorUserId) {
    throw new Error("creatorUserId is required for slash command reconciliation");
  }
  let existing = [];
  try {
    existing = await listMattermostCommands(client, teamId);
  } catch (err) {
    log?.(`mattermost: failed to list existing commands: ${String(err)}`);
    throw err;
  }
  const existingByTrigger = /* @__PURE__ */ new Map();
  for (const cmd of existing) {
    const list = existingByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    existingByTrigger.set(cmd.trigger, list);
  }
  const registered = [];
  for (const spec of commands) {
    const existingForTrigger = existingByTrigger.get(spec.trigger) ?? [];
    const ownedCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId
    );
    const foreignCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId
    );
    if (ownedCommands.length === 0 && foreignCommands.length > 0) {
      log?.(
        `mattermost: trigger /${spec.trigger} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`
      );
      continue;
    }
    if (ownedCommands.length > 1) {
      log?.(
        `mattermost: multiple owned commands found for /${spec.trigger}; using the first and leaving extras untouched`
      );
    }
    const existingCmd = ownedCommands[0];
    if (existingCmd && existingCmd.url === callbackUrl) {
      log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
      registered.push({
        id: existingCmd.id,
        trigger: spec.trigger,
        teamId,
        token: existingCmd.token,
        managed: false
      });
      continue;
    }
    if (existingCmd && existingCmd.url !== callbackUrl) {
      log?.(
        `mattermost: command /${spec.trigger} exists with different callback URL; updating (id=${existingCmd.id})`
      );
      try {
        const updated = await updateMattermostCommand(client, {
          id: existingCmd.id,
          team_id: teamId,
          trigger: spec.trigger,
          method: "P",
          url: callbackUrl,
          description: spec.description,
          auto_complete: spec.autoComplete,
          auto_complete_desc: spec.description,
          auto_complete_hint: spec.autoCompleteHint
        });
        registered.push({
          id: updated.id,
          trigger: spec.trigger,
          teamId,
          token: updated.token,
          managed: false
        });
        continue;
      } catch (err) {
        log?.(
          `mattermost: failed to update command /${spec.trigger} (id=${existingCmd.id}): ${String(err)}`
        );
        try {
          await deleteMattermostCommand(client, existingCmd.id);
          log?.(`mattermost: deleted stale command /${spec.trigger} (id=${existingCmd.id})`);
        } catch (deleteErr) {
          log?.(
            `mattermost: failed to delete stale command /${spec.trigger} (id=${existingCmd.id}): ${String(deleteErr)}`
          );
          continue;
        }
      }
    }
    try {
      const created = await createMattermostCommand(client, {
        team_id: teamId,
        trigger: spec.trigger,
        method: "P",
        url: callbackUrl,
        description: spec.description,
        auto_complete: spec.autoComplete,
        auto_complete_desc: spec.description,
        auto_complete_hint: spec.autoCompleteHint
      });
      log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
      registered.push({
        id: created.id,
        trigger: spec.trigger,
        teamId,
        token: created.token,
        managed: true
      });
    } catch (err) {
      log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
    }
  }
  return registered;
}
async function cleanupSlashCommands(params) {
  const { client, commands, log } = params;
  for (const cmd of commands) {
    if (!cmd.managed) {
      continue;
    }
    try {
      await deleteMattermostCommand(client, cmd.id);
      log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
    } catch (err) {
      log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(err)}`);
    }
  }
}
function parseSlashCommandPayload(body, contentType) {
  if (!body) {
    return null;
  }
  try {
    if (contentType?.includes("application/json")) {
      const parsed = JSON.parse(body);
      const token2 = typeof parsed.token === "string" ? parsed.token : "";
      const teamId2 = typeof parsed.team_id === "string" ? parsed.team_id : "";
      const channelId2 = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
      const userId2 = typeof parsed.user_id === "string" ? parsed.user_id : "";
      const command2 = typeof parsed.command === "string" ? parsed.command : "";
      if (!token2 || !teamId2 || !channelId2 || !userId2 || !command2) {
        return null;
      }
      return {
        token: token2,
        team_id: teamId2,
        team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : void 0,
        channel_id: channelId2,
        channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : void 0,
        user_id: userId2,
        user_name: typeof parsed.user_name === "string" ? parsed.user_name : void 0,
        command: command2,
        text: typeof parsed.text === "string" ? parsed.text : "",
        trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : void 0,
        response_url: typeof parsed.response_url === "string" ? parsed.response_url : void 0
      };
    }
    const params = new URLSearchParams(body);
    const token = params.get("token");
    const teamId = params.get("team_id");
    const channelId = params.get("channel_id");
    const userId = params.get("user_id");
    const command = params.get("command");
    if (!token || !teamId || !channelId || !userId || !command) {
      return null;
    }
    return {
      token,
      team_id: teamId,
      team_domain: params.get("team_domain") ?? void 0,
      channel_id: channelId,
      channel_name: params.get("channel_name") ?? void 0,
      user_id: userId,
      user_name: params.get("user_name") ?? void 0,
      command,
      text: params.get("text") ?? "",
      trigger_id: params.get("trigger_id") ?? void 0,
      response_url: params.get("response_url") ?? void 0
    };
  } catch {
    return null;
  }
}
function resolveCommandText(trigger, text, triggerMap) {
  const commandName = triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}
const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";
function normalizeCallbackPath(path) {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_CALLBACK_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function resolveSlashCommandConfig(raw) {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
    callbackUrl: raw?.callbackUrl?.trim() || void 0
  };
}
function isSlashCommandsEnabled(config) {
  if (config.native === true) {
    return true;
  }
  if (config.native === false) {
    return false;
  }
  return false;
}
function resolveCallbackUrl(params) {
  if (params.config.callbackUrl) {
    return params.config.callbackUrl;
  }
  const isWildcardBindHost = (rawHost) => {
    const trimmed = rawHost.trim();
    if (!trimmed) return false;
    const host2 = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    return host2 === "0.0.0.0" || host2 === "::" || host2 === "0:0:0:0:0:0:0:0" || host2 === "::0";
  };
  let host = params.gatewayHost && !isWildcardBindHost(params.gatewayHost) ? params.gatewayHost : "localhost";
  const path = normalizeCallbackPath(params.config.callbackPath);
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }
  return `http://${host}:${params.gatewayPort}${path}`;
}
export {
  DEFAULT_COMMAND_SPECS,
  cleanupSlashCommands,
  createMattermostCommand,
  deleteMattermostCommand,
  isSlashCommandsEnabled,
  listMattermostCommands,
  parseSlashCommandPayload,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveCommandText,
  resolveSlashCommandConfig,
  updateMattermostCommand
};
