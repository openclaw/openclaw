/**
 * Mattermost native slash command support.
 *
 * Registers custom slash commands via the Mattermost REST API and handles
 * incoming command callbacks via an HTTP endpoint on the gateway.
 *
 * Architecture:
 * - On startup, registers commands with MM via POST /api/v4/commands
 * - MM sends HTTP POST to callbackUrl when a user invokes a command
 * - The callback handler reconstructs the text as `/<command> <args>` and
 *   routes it through the standard inbound reply pipeline
 * - On shutdown, cleans up registered commands via DELETE /api/v4/commands/{id}
 */

import type { MattermostClient } from "./client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

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
};

export type MattermostRegisteredCommand = {
  id: string;
  trigger: string;
  teamId: string;
  token: string;
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

/**
 * Response format for Mattermost slash command callbacks.
 */
export type MattermostSlashCommandResponse = {
  response_type?: "ephemeral" | "in_channel";
  text: string;
  username?: string;
  icon_url?: string;
  goto_location?: string;
  attachments?: unknown[];
};

// ─── MM API types ────────────────────────────────────────────────────────────

type MattermostCommandCreate = {
  team_id: string;
  trigger: string;
  method: "P" | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
  token?: string;
  creator_id?: string;
};

type MattermostCommandResponse = {
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

// ─── Default commands ────────────────────────────────────────────────────────

/**
 * Built-in OpenClaw commands to register as native slash commands.
 * These mirror the text-based commands already handled by the gateway.
 */
export const DEFAULT_COMMAND_SPECS: MattermostCommandSpec[] = [
  {
    trigger: "oc_status",
    description: "Show session status (model, usage, uptime)",
    autoComplete: true,
  },
  {
    trigger: "oc_model",
    description: "View or change the current model",
    autoComplete: true,
    autoCompleteHint: "[model-name]",
  },
  {
    trigger: "oc_new",
    description: "Start a new conversation session",
    autoComplete: true,
  },
  {
    trigger: "oc_help",
    description: "Show available commands",
    autoComplete: true,
  },
  {
    trigger: "oc_think",
    description: "Set thinking/reasoning level",
    autoComplete: true,
    autoCompleteHint: "[off|low|medium|high]",
  },
  {
    trigger: "oc_reasoning",
    description: "Toggle reasoning mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]",
  },
  {
    trigger: "oc_verbose",
    description: "Toggle verbose mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]",
  },
];

// ─── Command registration ────────────────────────────────────────────────────

/**
 * List existing custom slash commands for a team.
 */
export async function listMattermostCommands(
  client: MattermostClient,
  teamId: string,
): Promise<MattermostCommandResponse[]> {
  return await client.request<MattermostCommandResponse[]>(
    `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`,
  );
}

/**
 * Create a custom slash command on a Mattermost team.
 */
export async function createMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandCreate,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>("/commands", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

/**
 * Delete a custom slash command.
 */
export async function deleteMattermostCommand(
  client: MattermostClient,
  commandId: string,
): Promise<void> {
  await client.request<Record<string, unknown>>(`/commands/${encodeURIComponent(commandId)}`, {
    method: "DELETE",
  });
}

/**
 * Register all OpenClaw slash commands for a given team.
 * Skips commands that are already registered with the same trigger + callback URL.
 * Returns the list of newly created command IDs.
 */
export async function registerSlashCommands(params: {
  client: MattermostClient;
  teamId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, teamId, callbackUrl, commands, log } = params;

  // Fetch existing commands to avoid duplicates
  let existing: MattermostCommandResponse[] = [];
  try {
    existing = await listMattermostCommands(client, teamId);
  } catch (err) {
    log?.(`mattermost: failed to list existing commands: ${String(err)}`);
  }

  const existingByTrigger = new Map(
    existing.filter((cmd) => cmd.url === callbackUrl).map((cmd) => [cmd.trigger, cmd]),
  );

  const registered: MattermostRegisteredCommand[] = [];

  for (const spec of commands) {
    // Skip if already registered with same callback URL
    const existingCmd = existingByTrigger.get(spec.trigger);
    if (existingCmd) {
      log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
      registered.push({
        id: existingCmd.id,
        trigger: spec.trigger,
        teamId,
        token: existingCmd.token,
      });
      continue;
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
        auto_complete_hint: spec.autoCompleteHint,
      });
      log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
      registered.push({
        id: created.id,
        trigger: spec.trigger,
        teamId,
        token: created.token,
      });
    } catch (err) {
      log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
    }
  }

  return registered;
}

/**
 * Clean up all registered slash commands.
 */
export async function cleanupSlashCommands(params: {
  client: MattermostClient;
  commands: MattermostRegisteredCommand[];
  log?: (msg: string) => void;
}): Promise<void> {
  const { client, commands, log } = params;
  for (const cmd of commands) {
    try {
      await deleteMattermostCommand(client, cmd.id);
      log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
    } catch (err) {
      log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(err)}`);
    }
  }
}

// ─── Callback parsing ────────────────────────────────────────────────────────

/**
 * Parse a Mattermost slash command callback payload from a URL-encoded or JSON body.
 */
export function parseSlashCommandPayload(
  body: string,
  contentType?: string,
): MattermostSlashCommandPayload | null {
  if (!body) {
    return null;
  }

  try {
    if (contentType?.includes("application/json")) {
      return JSON.parse(body) as MattermostSlashCommandPayload;
    }

    // Default: application/x-www-form-urlencoded
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
      team_domain: params.get("team_domain") ?? undefined,
      channel_id: channelId,
      channel_name: params.get("channel_name") ?? undefined,
      user_id: userId,
      user_name: params.get("user_name") ?? undefined,
      command,
      text: params.get("text") ?? "",
      trigger_id: params.get("trigger_id") ?? undefined,
      response_url: params.get("response_url") ?? undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Map the trigger word back to the original OpenClaw command name.
 * e.g. "oc_status" -> "/status", "oc_model" -> "/model"
 */
export function resolveCommandText(trigger: string, text: string): string {
  // Strip the "oc_" prefix to get the original command name
  const commandName = trigger.startsWith("oc_") ? trigger.slice(3) : trigger;
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

// ─── Config resolution ───────────────────────────────────────────────────────

const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: raw?.callbackPath?.trim() || DEFAULT_CALLBACK_PATH,
    callbackUrl: raw?.callbackUrl?.trim() || undefined,
  };
}

export function isSlashCommandsEnabled(config: MattermostSlashCommandConfig): boolean {
  if (config.native === true) {
    return true;
  }
  if (config.native === false) {
    return false;
  }
  // "auto" defaults to false for mattermost (opt-in)
  return false;
}

/**
 * Build the callback URL that Mattermost will POST to when a command is invoked.
 */
export function resolveCallbackUrl(params: {
  config: MattermostSlashCommandConfig;
  gatewayPort: number;
  gatewayHost?: string;
}): string {
  if (params.config.callbackUrl) {
    return params.config.callbackUrl;
  }
  const host = params.gatewayHost || "localhost";
  const path = params.config.callbackPath;
  return `http://${host}:${params.gatewayPort}${path}`;
}
