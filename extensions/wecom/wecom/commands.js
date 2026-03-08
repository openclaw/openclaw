import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_COMMAND_BLOCK_MESSAGE,
  HIGH_PRIORITY_COMMANDS,
} from "./constants.js";

/**
 * Read command allowlist settings from config.
 *
 * Accepts either the full openclaw config or a per-account wecom config block.
 */
export function getCommandConfig(config) {
  const wecom = config?.channels?.wecom ?? config ?? {};
  const commands = wecom.commands || {};
  return {
    allowlist: commands.allowlist || DEFAULT_COMMAND_ALLOWLIST,
    blockMessage: commands.blockMessage || DEFAULT_COMMAND_BLOCK_MESSAGE,
    enabled: commands.enabled !== false,
  };
}

/**
 * Check whether a slash command is allowed.
 * @param {string} message - User message
 * @param {Object} config - OpenClaw config
 * @returns {{ isCommand: boolean, allowed: boolean, command: string | null }}
 */
export function checkCommandAllowlist(message, config) {
  const trimmed = String(message || "").trim();

  // Not a slash command.
  if (!trimmed.startsWith("/")) {
    return { isCommand: false, allowed: true, command: null };
  }

  // Use the first token as the command.
  const command = trimmed.split(/\s+/)[0].toLowerCase();

  const cmdConfig = getCommandConfig(config);

  // Allow all commands when command gating is disabled.
  if (!cmdConfig.enabled) {
    return { isCommand: true, allowed: true, command };
  }

  // Require explicit allowlist match.
  const allowed = cmdConfig.allowlist.some((cmd) => cmd.toLowerCase() === command);

  return { isCommand: true, allowed, command };
}

/**
 * Read admin user list from wecom config.
 * Admins bypass the command allowlist, but still keep dynamic agent routing.
 *
 * Accepts either the full openclaw config or a per-account wecom config block.
 */
export function getWecomAdminUsers(config) {
  const wecom = config?.channels?.wecom ?? config ?? {};
  const raw = wecom.adminUsers;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((u) => String(u ?? "").trim().toLowerCase())
    .filter(Boolean);
}

export function isWecomAdmin(userId, config) {
  if (!userId) {
    return false;
  }
  const admins = getWecomAdminUsers(config);
  return admins.length > 0 && admins.includes(String(userId).trim().toLowerCase());
}

export function extractLeadingSlashCommand(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  return trimmed.split(/\s+/)[0].toLowerCase();
}

export function isHighPriorityCommand(command) {
  if (!command) {
    return false;
  }
  return HIGH_PRIORITY_COMMANDS.has(command.toLowerCase());
}
