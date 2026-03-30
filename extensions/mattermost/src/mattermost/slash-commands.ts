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

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "openclaw/plugin-sdk/infra-runtime";
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
  /** Original command name (for skill commands that start with oc_) */
  originalName?: string;
};

export type MattermostRegisteredCommand = {
  id: string;
  trigger: string;
  teamId: string;
  token: string;
  callbackUrl: string;
  /** True when this process created the command and should delete it on shutdown. */
  managed: boolean;
};

type PersistedMattermostRegisteredCommand = Omit<MattermostRegisteredCommand, "managed"> & {
  managed?: boolean;
};

type PersistedMattermostSlashCommandState = {
  version: 1;
  ownerId?: string;
  commands: PersistedMattermostRegisteredCommand[];
};

export type MattermostPersistedSlashCommandState = {
  ownerId: string | null;
  commands: MattermostRegisteredCommand[];
};

const SLASH_COMMAND_STATE_VERSION = 1;

export class MattermostIncompleteBlindCreateError extends Error {
  readonly recoverableCommands: MattermostRegisteredCommand[];
  override readonly cause: unknown;

  constructor(
    message: string,
    params: { cause: unknown; recoverableCommands: MattermostRegisteredCommand[] },
  ) {
    super(message);
    this.name = "MattermostIncompleteBlindCreateError";
    this.cause = params.cause;
    this.recoverableCommands = params.recoverableCommands;
  }
}

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

type MattermostCommandUpdate = {
  id: string;
  team_id: string;
  trigger: string;
  method: "P" | "G";
  url: string;
  description?: string;
  auto_complete: boolean;
  auto_complete_desc?: string;
  auto_complete_hint?: string;
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
    originalName: "status",
    description: "Show session status (model, usage, uptime)",
    autoComplete: true,
  },
  {
    trigger: "oc_model",
    originalName: "model",
    description: "View or change the current model",
    autoComplete: true,
    autoCompleteHint: "[model-name]",
  },
  {
    trigger: "oc_models",
    originalName: "models",
    description: "Browse available models",
    autoComplete: true,
    autoCompleteHint: "[provider]",
  },
  {
    trigger: "oc_new",
    originalName: "new",
    description: "Start a new conversation session",
    autoComplete: true,
  },
  {
    trigger: "oc_help",
    originalName: "help",
    description: "Show available commands",
    autoComplete: true,
  },
  {
    trigger: "oc_think",
    originalName: "think",
    description: "Set thinking/reasoning level",
    autoComplete: true,
    autoCompleteHint: "[off|low|medium|high]",
  },
  {
    trigger: "oc_reasoning",
    originalName: "reasoning",
    description: "Toggle reasoning mode",
    autoComplete: true,
    autoCompleteHint: "[on|off]",
  },
  {
    trigger: "oc_verbose",
    originalName: "verbose",
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
 * Update an existing custom slash command.
 */
export async function updateMattermostCommand(
  client: MattermostClient,
  params: MattermostCommandUpdate,
): Promise<MattermostCommandResponse> {
  return await client.request<MattermostCommandResponse>(
    `/commands/${encodeURIComponent(params.id)}`,
    {
      method: "PUT",
      body: JSON.stringify(params),
    },
  );
}

function isMattermostRegisteredCommand(value: unknown): value is MattermostRegisteredCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.trigger === "string" &&
    typeof entry.teamId === "string" &&
    typeof entry.token === "string" &&
    typeof entry.callbackUrl === "string" &&
    typeof entry.managed === "boolean"
  );
}

function isPersistedMattermostRegisteredCommand(
  value: unknown,
): value is PersistedMattermostRegisteredCommand {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.trigger === "string" &&
    typeof entry.teamId === "string" &&
    typeof entry.token === "string" &&
    typeof entry.callbackUrl === "string" &&
    (entry.managed === undefined || typeof entry.managed === "boolean")
  );
}

function cloneRegisteredCommands(
  commands: MattermostRegisteredCommand[],
): MattermostRegisteredCommand[] {
  return commands.filter(isMattermostRegisteredCommand).map((entry) => ({
    id: entry.id,
    trigger: entry.trigger,
    teamId: entry.teamId,
    token: entry.token,
    callbackUrl: entry.callbackUrl,
    managed: entry.managed,
  }));
}

function normalizePersistedCommands(value: unknown): MattermostRegisteredCommand[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const commands: MattermostRegisteredCommand[] = [];
  for (const entry of value) {
    if (!isPersistedMattermostRegisteredCommand(entry)) {
      continue;
    }
    commands.push({
      id: entry.id,
      trigger: entry.trigger,
      teamId: entry.teamId,
      token: entry.token,
      callbackUrl: entry.callbackUrl,
      // Persisted cache is restart metadata only. Never trust disk state to
      // decide whether shutdown should remotely delete a command.
      managed: false,
    });
  }
  return commands;
}

function serializePersistedCommands(
  commands: MattermostRegisteredCommand[],
): PersistedMattermostRegisteredCommand[] {
  return cloneRegisteredCommands(commands).map((entry) => ({
    id: entry.id,
    trigger: entry.trigger,
    teamId: entry.teamId,
    token: entry.token,
    callbackUrl: entry.callbackUrl,
  }));
}

function sanitizeAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveSlashCommandCachePath(stateDir: string, accountId: string): string {
  return path.join(
    stateDir,
    "mattermost",
    "slash-commands",
    `${sanitizeAccountId(accountId)}.json`,
  );
}

export async function loadPersistedSlashCommands(
  cachePath: string,
  log?: (msg: string) => void,
): Promise<MattermostRegisteredCommand[]> {
  return (await loadPersistedSlashCommandState(cachePath, log)).commands;
}

export async function loadPersistedSlashCommandState(
  cachePath: string,
  log?: (msg: string) => void,
): Promise<MattermostPersistedSlashCommandState> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedMattermostSlashCommandState> | null;
    if (!parsed || parsed.version !== SLASH_COMMAND_STATE_VERSION) {
      log?.(`mattermost: ignoring slash command cache at ${cachePath} due to unsupported version`);
      return { ownerId: null, commands: [] };
    }
    const ownerId =
      typeof parsed.ownerId === "string" && parsed.ownerId.trim() ? parsed.ownerId : null;
    return {
      ownerId,
      commands: normalizePersistedCommands(parsed.commands),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ownerId: null, commands: [] };
    }
    log?.(`mattermost: failed to load slash command cache ${cachePath}: ${String(err)}`);
    return { ownerId: null, commands: [] };
  }
}

export async function savePersistedSlashCommands(
  cachePath: string,
  commands: MattermostRegisteredCommand[],
  log?: (msg: string) => void,
): Promise<void> {
  await savePersistedSlashCommandState(cachePath, { commands }, log);
}

export async function savePersistedSlashCommandState(
  cachePath: string,
  state: { commands: MattermostRegisteredCommand[]; ownerId?: string | null },
  log?: (msg: string) => void,
): Promise<void> {
  try {
    const payload: PersistedMattermostSlashCommandState = {
      version: SLASH_COMMAND_STATE_VERSION,
      commands: serializePersistedCommands(state.commands),
    };
    if (state.ownerId?.trim()) {
      payload.ownerId = state.ownerId;
    }
    await writeJsonAtomic(cachePath, payload, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  } catch (err) {
    log?.(`mattermost: failed to save slash command cache ${cachePath}: ${String(err)}`);
  }
}

export async function removePersistedSlashCommands(
  cachePath: string,
  log?: (msg: string) => void,
): Promise<void> {
  try {
    await fs.rm(cachePath, { force: true });
  } catch (err) {
    log?.(`mattermost: failed to remove slash command cache ${cachePath}: ${String(err)}`);
  }
}

export function shouldBlindCreateFromListError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return /^Mattermost API 403\b/i.test(message.trim());
}

export function mergePersistedSlashCommands(params: {
  cachedCommands: MattermostRegisteredCommand[];
  registeredCommands: MattermostRegisteredCommand[];
  refreshedTeamIds: Iterable<string>;
}): MattermostRegisteredCommand[] {
  const refreshedTeamIds = new Set(
    [...params.refreshedTeamIds].map((teamId) => teamId.trim()).filter(Boolean),
  );
  const preservedCachedCommands = params.cachedCommands.filter(
    (cmd) => !refreshedTeamIds.has(cmd.teamId.trim()),
  );
  return cloneRegisteredCommands([...preservedCachedCommands, ...params.registeredCommands]);
}

/**
 * Register all OpenClaw slash commands for a given team.
 * Skips commands that are already registered with the same trigger + callback URL.
 * Falls back to a persisted cache only when Mattermost refuses GET /commands
 * with a 403 but still allows POST /commands for bot tokens.
 */
export async function registerSlashCommands(params: {
  client: MattermostClient;
  teamId: string;
  creatorUserId: string;
  callbackUrl: string;
  commands: MattermostCommandSpec[];
  cachedCommands?: MattermostRegisteredCommand[];
  log?: (msg: string) => void;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, teamId, creatorUserId, callbackUrl, commands, cachedCommands, log } = params;
  const normalizedCreatorUserId = creatorUserId.trim();
  if (!normalizedCreatorUserId) {
    throw new Error("creatorUserId is required for slash command reconciliation");
  }

  // Fetch existing commands to avoid duplicates
  let existing: MattermostCommandResponse[] = [];
  let listError: unknown;
  let allowBlindCreate = false;
  try {
    existing = await listMattermostCommands(client, teamId);
  } catch (err) {
    listError = err;
    log?.(`mattermost: failed to list existing commands: ${String(err)}`);
    allowBlindCreate = shouldBlindCreateFromListError(err);
    if (!allowBlindCreate) {
      throw err;
    }
    // Some Mattermost deployments allow POST /commands for bot tokens while
    // rejecting GET /commands with 403. Fall back to blind-create, but only
    // activate slash callbacks if every requested trigger is created successfully.
  }

  const existingByTrigger = new Map<string, MattermostCommandResponse[]>();
  for (const cmd of existing) {
    const list = existingByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    existingByTrigger.set(cmd.trigger, list);
  }

  const registered: MattermostRegisteredCommand[] = [];
  const createdThisRun: MattermostRegisteredCommand[] = [];
  const cachedByTrigger = new Map<string, MattermostRegisteredCommand[]>();
  for (const cmd of cachedCommands ?? []) {
    if (cmd.teamId !== teamId || cmd.callbackUrl !== callbackUrl) {
      continue;
    }
    const list = cachedByTrigger.get(cmd.trigger) ?? [];
    list.push(cmd);
    cachedByTrigger.set(cmd.trigger, list);
  }

  for (const spec of commands) {
    if (allowBlindCreate) {
      const cachedForTrigger = cachedByTrigger.get(spec.trigger) ?? [];
      if (cachedForTrigger.length > 1) {
        log?.(
          `mattermost: multiple cached commands found for /${spec.trigger}; using the first and leaving extras untouched`,
        );
      }
      const cachedCmd = cachedForTrigger[0];
      if (cachedCmd) {
        log?.(
          `mattermost: reusing cached command /${spec.trigger} after listing failed (id=${cachedCmd.id})`,
        );
        registered.push({
          ...cachedCmd,
          managed: false,
        });
        continue;
      }
    }

    const existingForTrigger = allowBlindCreate ? [] : (existingByTrigger.get(spec.trigger) ?? []);
    const ownedCommands = allowBlindCreate
      ? []
      : existingForTrigger.filter((cmd) => cmd.creator_id?.trim() === normalizedCreatorUserId);
    const foreignCommands = allowBlindCreate
      ? []
      : existingForTrigger.filter((cmd) => cmd.creator_id?.trim() !== normalizedCreatorUserId);

    if (ownedCommands.length === 0 && foreignCommands.length > 0) {
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

    // Already registered with the correct callback URL
    if (existingCmd && existingCmd.url === callbackUrl) {
      log?.(`mattermost: command /${spec.trigger} already registered (id=${existingCmd.id})`);
      registered.push({
        id: existingCmd.id,
        trigger: spec.trigger,
        teamId,
        token: existingCmd.token,
        callbackUrl,
        managed: false,
      });
      continue;
    }

    // Exists but points to a different URL: attempt to reconcile by updating
    // (useful during callback URL migrations).
    if (existingCmd && existingCmd.url !== callbackUrl) {
      log?.(
        `mattermost: command /${spec.trigger} exists with different callback URL; updating (id=${existingCmd.id})`,
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
          auto_complete_hint: spec.autoCompleteHint,
        });
        registered.push({
          id: updated.id,
          trigger: spec.trigger,
          teamId,
          token: updated.token,
          callbackUrl,
          managed: false,
        });
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
          // Can't reconcile; skip this command.
          continue;
        }
        // Continue on to create below.
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
        auto_complete_hint: spec.autoCompleteHint,
      });
      log?.(`mattermost: registered command /${spec.trigger} (id=${created.id})`);
      registered.push({
        id: created.id,
        trigger: spec.trigger,
        teamId,
        token: created.token,
        callbackUrl,
        managed: true,
      });
      createdThisRun.push({
        id: created.id,
        trigger: spec.trigger,
        teamId,
        token: created.token,
        callbackUrl,
        managed: true,
      });
    } catch (err) {
      log?.(`mattermost: failed to register command /${spec.trigger}: ${String(err)}`);
    }
  }

  if (allowBlindCreate && registered.length !== commands.length) {
    log?.(
      "mattermost: command listing failed and blind-create was incomplete; deleting commands created in this boot and keeping slash callbacks inactive",
    );
    const createdCommandIds = new Set(createdThisRun.map((cmd) => cmd.id));
    const recoverableCommands = registered.filter((cmd) => !createdCommandIds.has(cmd.id));
    for (const cmd of createdThisRun) {
      try {
        await deleteMattermostCommand(client, cmd.id);
      } catch (err) {
        log?.(
          `mattermost: failed to delete blind-created command /${cmd.trigger} (id=${cmd.id}): ${String(err)}`,
        );
        recoverableCommands.push(cmd);
      }
    }
    const message =
      listError instanceof Error
        ? listError.message
        : String(listError ?? "blind-create incomplete");
    throw new MattermostIncompleteBlindCreateError(message, {
      cause: listError,
      recoverableCommands: cloneRegisteredCommands(recoverableCommands),
    });
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
  shouldDelete?: (command: MattermostRegisteredCommand) => boolean | Promise<boolean>;
}): Promise<MattermostRegisteredCommand[]> {
  const { client, commands, log, shouldDelete } = params;
  const remaining: MattermostRegisteredCommand[] = [];
  for (const cmd of commands) {
    if (!cmd.managed) {
      remaining.push(cmd);
      continue;
    }
    if (shouldDelete && !(await shouldDelete(cmd))) {
      remaining.push(cmd);
      continue;
    }
    try {
      await deleteMattermostCommand(client, cmd.id);
      log?.(`mattermost: deleted command /${cmd.trigger} (id=${cmd.id})`);
    } catch (err) {
      log?.(`mattermost: failed to delete command /${cmd.trigger}: ${String(err)}`);
      remaining.push(cmd);
    }
  }
  return remaining;
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
      const parsed = JSON.parse(body) as Record<string, unknown>;

      // Validate required fields (same checks as the form-encoded branch)
      const token = typeof parsed.token === "string" ? parsed.token : "";
      const teamId = typeof parsed.team_id === "string" ? parsed.team_id : "";
      const channelId = typeof parsed.channel_id === "string" ? parsed.channel_id : "";
      const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
      const command = typeof parsed.command === "string" ? parsed.command : "";

      if (!token || !teamId || !channelId || !userId || !command) {
        return null;
      }

      return {
        token,
        team_id: teamId,
        team_domain: typeof parsed.team_domain === "string" ? parsed.team_domain : undefined,
        channel_id: channelId,
        channel_name: typeof parsed.channel_name === "string" ? parsed.channel_name : undefined,
        user_id: userId,
        user_name: typeof parsed.user_name === "string" ? parsed.user_name : undefined,
        command,
        text: typeof parsed.text === "string" ? parsed.text : "",
        trigger_id: typeof parsed.trigger_id === "string" ? parsed.trigger_id : undefined,
        response_url: typeof parsed.response_url === "string" ? parsed.response_url : undefined,
      };
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
export function resolveCommandText(
  trigger: string,
  text: string,
  triggerMap?: ReadonlyMap<string, string>,
): string {
  // Use the trigger map if available for accurate name resolution
  const commandName =
    triggerMap?.get(trigger) ?? (trigger.startsWith("oc_") ? trigger.slice(3) : trigger);
  const args = text.trim();
  return args ? `/${commandName} ${args}` : `/${commandName}`;
}

// ─── Config resolution ───────────────────────────────────────────────────────

const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";

/**
 * Ensure the callback path starts with a leading `/` to prevent
 * malformed URLs like `http://host:portapi/...`.
 */
function normalizeCallbackPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_CALLBACK_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
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

  const isWildcardBindHost = (rawHost: string): boolean => {
    const trimmed = rawHost.trim();
    if (!trimmed) return false;
    const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

    // NOTE: Wildcard listen hosts are valid bind addresses but are not routable callback
    // destinations. Don't emit callback URLs like http://0.0.0.0:3015/... or http://[::]:3015/...
    // when an operator sets gateway.customBindHost.
    return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
  };

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
