import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { isWildcardBindHost } from "./callback-host.js";
import type { MattermostClient } from "./client.js";

// Mattermost rejects command descriptions above 128 UTF-8 bytes. Keep portable
// descriptions intact until this API boundary so other channels retain their text.
export const MATTERMOST_SLASH_POST_METHOD = "P";
const MATTERMOST_COMMAND_DESCRIPTION_MAX_BYTES = 128;

export type MattermostSlashCommandConfig = {
  /** Enable native slash commands. "auto" resolves to false for now (opt-in). */
  native: boolean | "auto";
  /** Also register skill-based commands. */
  nativeSkills: boolean | "auto";
  /** Path for the callback endpoint on the gateway HTTP server. */
  callbackPath: string;
  /**
   * Explicit callback URL override (e.g. behind a reverse proxy).
   * If not set, auto-derived from baseUrl + gateway port + callbackPath.
   */
  callbackUrl?: string;
};

export type MattermostCommandSpec = {
  trigger: string;
  description: string;
  autoComplete: boolean;
  autoCompleteHint?: string;
  /** Original command name (for skill commands that start with oc_) */
  originalName?: string;
};

export type MattermostRegisteredCommand = {
  id: string;
  trigger: string;
  teamId: string;
  token: string;
  url: string;
  /** True when this process created the command and should delete it on shutdown. */
  managed: boolean;
};

/**
 * Payload sent by Mattermost when a slash command is invoked.
 * Can arrive as application/x-www-form-urlencoded or application/json.
 */
export type MattermostSlashCommandPayload = {
  token: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  command: string; // e.g. "/status"
  text: string; // args after the trigger word
  trigger_id?: string;
  response_url?: string;
};

export type MattermostSlashCommandResponse = {
  response_type?: "ephemeral" | "in_channel";
  text: string;
  username?: string;
  icon_url?: string;
  goto_location?: string;
  attachments?: unknown[];
};

type MattermostCommandCreate = {
  team_id: string;
  trigger: string;
  method: typeof MATTERMOST_SLASH_POST_METHOD | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  token?: string;
  creator_id?: string;
};

export type MattermostCommandResponse = {
  id: string;
  token: string;
  team_id: string;
  trigger: string;
  method: string;
  url: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  creator_id?: string;
  create_at?: number;
  update_at?: number;
  delete_at?: number;
};

/**
 * Built-in OpenClaw commands to register as native slash commands.
 * These mirror the text-based commands already handled by the gateway.
 */
export const DEFAULT_COMMAND_SPECS: MattermostCommandSpec[] = [
  {
    originalName: "status",
    description: "Show session status (model, usage, uptime)",
  },
  {
    originalName: "model",
    description: "View or change the current model",
    autoCompleteHint: "[model-name] [--runtime runtime]",
  },
  {
    originalName: "models",
    description: "Browse available models",
    autoCompleteHint: "[provider]",
  },
  {
    originalName: "new",
    description: "Start a new conversation session",
  },
  {
    originalName: "help",
    description: "Show available commands",
  },
  {
    originalName: "think",
    description: "Set thinking/reasoning level",
    autoCompleteHint: "[off|low|medium|high]",
  },
  {
    originalName: "reasoning",
    description: "Toggle reasoning mode",
    autoCompleteHint: "[on|off]",
  },
  {
    originalName: "verbose",
    description: "Toggle verbose mode",
    autoCompleteHint: "[on|off]",
  },
  {
    originalName: "queue",
    description: "Adjust active-run queue behavior",
    autoCompleteHint:
      "[steer|followup|collect|interrupt] [debounce:2s] [cap:N] [drop:old|new|summarize]",
  },
].map((spec) => Object.assign(spec, { trigger: `oc_${spec.originalName}`, autoComplete: true }));

export async function listMattermostCommands(
  client: MattermostClient,
  teamId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<MattermostCommandResponse[]> {
  return await client.request<MattermostCommandResponse[]>(
    `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`,
    init,
  );
}

export async function getMattermostCommand(
  client: MattermostClient,
  commandId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(commandId)}`,
    init,
  );
}

async function deleteMattermostCommand(client: MattermostClient, commandId: string): Promise<void> {
  // Mattermost answers with 200 {"status":"OK"}; registration recreates the command after this.
  await client.request<void>(`/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE",
    discardResponse: true,
  });
}

/** Reconcile owned commands without modifying another integration's trigger. */
export async function registerSlashCommands(params: {
  client: MattermostClient;
  teamId: string;
  creatorUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, teamId, creatorUserId, callbackUrl, commands, log } = params;
  const normalizedCreatorUserId = creatorUserId.trim();
  if (!normalizedCreatorUserId) {
    throw new Error("creatorUserId is required for slash command reconciliation");
  }

  let existing: MattermostCommandResponse[];
  try {
    existing = await listMattermostCommands(client, teamId);
  } catch (err) {
    log?.(`mattermost: failed to list existing commands: ${String(err)}`);
    // Fail closed: if we can't list existing commands, we should not attempt to
    // create/update anything because we may create duplicates and end up with an
    // empty/partial token set (causing callbacks to be rejected until restart).
    throw err;
  }

  const existingByTrigger = new Map<string, MattermostCommandResponse[]>();
  for (const cmd of existing) {
    const list = existingByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    existingByTrigger.set(cmd.trigger, list);
  }

  const registered: MattermostRegisteredCommand[] = [];

  for (const spec of commands) {
    const description = truncateUtf8Prefix(
      spec.description,
      MATTERMOST_COMMAND_DESCRIPTION_MAX_BYTES,
    );
    const existingForTrigger = existingByTrigger.get(spec.trigger) ?? [];
    const ownedCommands = existingForTrigger.filter(
      (cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId,
    );
    if (ownedCommands.length === 0 && existingForTrigger.length > 0) {
      log?.(
        `mattermost: trigger /${spec.trigger} already used by non-OpenClaw command(s); skipping to avoid mutating external integrations`,
      );
      continue;
    }

    if (ownedCommands.length > 1) {
      log?.(
        `mattermost: multiple owned commands found for /${spec.trigger}; using the first and leaving extras untouched`,
      );
    }

    const existingCmd = ownedCommands[0];
    const command: MattermostCommandCreate = {
      team_id: teamId,
      trigger: spec.trigger,
      method: MATTERMOST_SLASH_POST_METHOD,
      url: callbackUrl,
      description,
      auto_complete: spec.autoComplete,
      auto_complete_desc: description,
      auto_complete_hint: spec.autoCompleteHint,
    };

    const recordCommand = (receipt: MattermostCommandResponse, managed: boolean) => {
      registered.push({
        id: receipt.id,
        trigger: spec.trigger,
        teamId,
        token: receipt.token,
        url: callbackUrl,
        managed,
      });
    };

    if (existingCmd?.url === callbackUrl && existingCmd.method === MATTERMOST_SLASH_POST_METHOD) {
      log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
      recordCommand(existingCmd, false);
      continue;
    }

    // Exists but has drifted critical callback fields: attempt to reconcile by
    // updating (useful during callback URL migrations or method drift).
    if (existingCmd) {
      log?.(
        `mattermost: command /${spec.trigger} exists with different callback settings; updating (id=${existingCmd.id})`,
      );
      try {
        const updated = await client.request<MattermostCommandResponse>(
          `/commands/${encodeURIComponent(existingCmd.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({ id: existingCmd.id, ...command }),
          },
        );
        recordCommand(updated, false);
        continue;
      } catch (err) {
        log?.(
          `mattermost: failed to update command /${spec.trigger} (id=${existingCmd.id}): ${String(err)}`,
        );
        // Fallback: try delete+recreate for commands owned by this bot user.
        try {
          await deleteMattermostCommand(client, existingCmd.id);
          log?.(`mattermost: deleted stale command /${spec.trigger} (id=${existingCmd.id})`);
        } catch (deleteErr) {
          log?.(
            `mattermost: failed to delete stale command /${spec.trigger} (id=${existingCmd.id}): ${String(deleteErr)}`,
          );
          continue;
        }
      }
    }

    try {
      const created = await client.request<MattermostCommandResponse>("/commands", {
        method: "POST",
        body: JSON.stringify(command),
      });
      log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
      recordCommand(created, true);
    } catch (err) {
      log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
    }
  }

  return registered;
}

export async function cleanupSlashCommands(params: {
  client: MattermostClient;
  commands: MattermostRegisteredCommand[];
  log?: (msg: string) => void;
}): Promise<void> {
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

export function parseSlashCommandPayload(
  body: string,
  contentType?: string,
): MattermostSlashCommandPayload | null {
  if (!body) {
    return null;
  }

  try {
    const json = contentType?.includes("application/json");
    const parsed = json ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    const form = json ? undefined : new URLSearchParams(body);
    const read = (key: string): string | undefined => {
      const value = form ? form.get(key) : parsed?.[key];
      return typeof value === "string" ? value : undefined;
    };
    const token = read("token");
    const teamId = read("team_id");
    const channelId = read("channel_id");
    const userId = read("user_id");
    const command = read("command");

    if (!token || !teamId || !channelId || !userId || !command) {
      return null;
    }

    return {
      token,
      team_id: teamId,
      team_domain: read("team_domain"),
      channel_id: channelId,
      channel_name: read("channel_name"),
      user_id: userId,
      user_name: read("user_name"),
      command,
      text: read("text") ?? "",
      trigger_id: read("trigger_id"),
      response_url: read("response_url"),
    };
  } catch {
    return null;
  }
}

/**
 * Map the trigger word back to the original OpenClaw command name.
 * e.g. "oc_status" -> "/status", "oc_model" -> "/model"
 */
export function resolveCommandText(
  trigger: string,
  text: string,
  triggerMap?: ReadonlyMap<string, string>,
): string {
  const commandName =
    triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

export function normalizeSlashCommandTrigger(command: string): string {
  return command.replace(/^\//, "").trim();
}

const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";

/**
 * Ensure the callback path starts with a leading `/` to prevent
 * malformed URLs like `http://host:portapi/...`.
 */
function normalizeCallbackPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_CALLBACK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
    callbackUrl: normalizeOptionalString(raw?.callbackUrl),
  };
}

export function isSlashCommandsEnabled(config: MattermostSlashCommandConfig): boolean {
  // "auto" defaults to false for mattermost (opt-in)
  return config.native === true;
}

export function resolveCallbackUrl(params: {
  config: MattermostSlashCommandConfig;
  gatewayPort: number;
  gatewayHost?: string;
}): string {
  if (params.config.callbackUrl) {
    return params.config.callbackUrl;
  }

  let host =
    params.gatewayHost && !isWildcardBindHost(params.gatewayHost)
      ? params.gatewayHost
      : "localhost";
  const path = normalizeCallbackPath(params.config.callbackPath);

  // Bracket IPv6 literals so the URL is valid: http://[::1]:3015/...
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    host = `[${host}]`;
  }

  return `http://${host}:${params.gatewayPort}${path}`;
}
