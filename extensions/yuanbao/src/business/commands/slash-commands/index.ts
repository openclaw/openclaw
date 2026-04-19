/**
 * Slash command registry.
 *
 * Maintains the list of /commands available in Bot direct-message scenarios.
 * Split by protocol into bot_commands (OpenClaw built-in) and plugin_commands (plugin-provided).
 *
 * - plugin_commands: dynamically collected during plugin registration (registerPluginCommand)
 * - bot_commands: dynamically fetched via openclaw/plugin-sdk/command-auth's listChatCommands
 *
 * Usage:
 *   import { buildSyncCommandsPayload } from './commands/slash-commands/index.js';
 *   const payload = buildSyncCommandsPayload(config);
 *   await client.syncInformation(payload);
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getPluginVersion, getOpenclawVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";

// ============ Dynamic loading of command-auth (compat with older OpenClaw) ============

/**
 * openclaw/plugin-sdk/command-auth is only available in newer versions (>= 2026.4).
 * Older OpenClaw (e.g. 2026.3.x) lacks this module; static import would cause plugin load failure.
 * Therefore use runtime import() for dynamic loading, falling back to default list on failure.
 *
 * Note: project is ESM ("type": "module"), must use import() not require().
 */
let _listChatCommands: ((options?: Record<string, unknown>) => ChatCommandDef[]) | null = null;
let _listChatCommandsForConfig: ((cfg: Record<string, unknown>, options?: Record<string, unknown>) => ChatCommandDef[]) | null = null;
let _commandAuthLoadPromise: Promise<void> | null = null;

function loadCommandAuth(): Promise<void> {
  if (_commandAuthLoadPromise) {
    return _commandAuthLoadPromise;
  }
  _commandAuthLoadPromise = import("openclaw/plugin-sdk/command-auth")
    .then((mod) => {
      _listChatCommands = mod.listChatCommands;
      _listChatCommandsForConfig = mod.listChatCommandsForConfig;
    })
    .catch(() => {
      const log = createLog("slash-commands");
      log.warn(
        "openclaw/plugin-sdk/command-auth 不可用（当前 OpenClaw 版本可能较旧），bot_commands 将返回兜底列表",
      );
    });
  return _commandAuthLoadPromise;
}

// ============ Types ============

export type CommandItem = {
  /** Command name (with /), e.g. "/help" */
  name: string;
  /** Command description */
  description: string;
};

/** Command definition returned by openclaw/plugin-sdk/command-auth */
type ChatCommandDef = {
  name?: string;
  description?: string;
  textAliases?: string[];
  [key: string]: unknown;
};

// ============ SyncInformation protocol constants ============

export const SYNC_INFORMATION_TYPE = {
  UNSPECIFIED: 0,
  COMMANDS: 1,
} as const;

// ============ bot_commands: dynamically fetched from OpenClaw SDK ============

/**
 * Fallback command list: used when command-auth module is unavailable (older OpenClaw).
 * Contains known common OpenClaw framework built-in commands.
 */
const FALLBACK_BOT_COMMANDS: CommandItem[] = [
  { name: "/help", description: "Show available commands." },
  { name: "/status", description: "Show current status." },
  { name: "/stop", description: "Stop the current run." },
  { name: "/new", description: "Start a new session." },
  { name: "/restart", description: "Restart OpenClaw." },
  { name: "/compact", description: "Compact the session context." },
];

/**
 * Fetch full OpenClaw framework command list.
 *
 * Prefers dynamic fetch via command-auth module (new OpenClaw >= 2026.4),
 * falls back to default list when older OpenClaw doesn't support it.
 */
async function fetchBotCommands(config?: OpenClawConfig): Promise<ChatCommandDef[] | null> {
  const log = createLog("slash-commands");

  await loadCommandAuth();

  if (!_listChatCommandsForConfig && !_listChatCommands) {
    log.info(
      `command-auth 模块不可用（旧版 OpenClaw），使用兜底命令列表: ${FALLBACK_BOT_COMMANDS.length} 个命令`,
    );
    return FALLBACK_BOT_COMMANDS as ChatCommandDef[];
  }

  try {
    if (config && _listChatCommandsForConfig) {
      const commands = _listChatCommandsForConfig(config);
      log.debug(`使用配置感知版本获取命令列表: ${commands.length} 个命令`);
      if (commands.length > 0) {
      log.debug("命令原始结构示例:", {
        sample: commands.slice(0, 3).map((c) => ({
          name: c.name,
          description: c.description,
          textAliases: c.textAliases,
          keys: Object.keys(c),
        })),
      });
      }
      return commands;
    }

    if (_listChatCommands) {
      log.debug("OpenClawConfig 不可用, 降级为无参版本");
      const commands = _listChatCommands();
      log.debug(`使用无参版本获取命令列表: ${commands.length} 个命令`);
      return commands;
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`获取命令列表失败: ${msg}`);
    return null;
  }
}

/**
 * Convert ChatCommandDefinition[] to CommandItem[].
 *
 * Commands returned by listChatCommandsForConfig may have various field names:
 * - name: command name (may not include /)
 * - textAliases: text alias array (e.g. ["/help", "/commands"])
 * - description: command description
 */
function toBotCommandItems(commands: ChatCommandDef[]): CommandItem[] {
  const log = createLog("slash-commands");
  const result: CommandItem[] = [];

  for (const cmd of commands) {
    // Prefer first entry in textAliases (usually the primary command name, with /)
    const aliases = cmd.textAliases;
    let name = "";
    if (aliases && aliases.length > 0) {
      [name] = aliases;
    } else if (cmd.name) {
      name = cmd.name;
    }

    if (!name) {
      continue;
    }
    if (!name.startsWith("/")) {
      name = `/${name}`;
    }
    if (name.length <= 1) {
      continue;
    }

    result.push({
      name,
      description: cmd.description ?? "",
    });
  }

  log.debug(`toBotCommandItems 转换结果: ${result.length} 个命令`);
  return result;
}

// ============ plugin_commands: dynamically collected ============

/**
 * Plugin-registered command list (collected at runtime).
 *
 * After each api.registerCommand call in channel.ts register(),
 * registerPluginCommand is called synchronously to record command info here.
 */
const pluginCommands: CommandItem[] = [];

/**
 * Register a plugin command to the sync list.
 * Called in channel.ts plugin.register(), paired with api.registerCommand.
 */
export function registerPluginCommand(name: string, description: string): void {
  const fullName = name.startsWith("/") ? name : `/${name}`;
  // Deduplicate
  if (!pluginCommands.some((c) => c.name === fullName)) {
    pluginCommands.push({ name: fullName, description });
  }
}

/**
 * Get registered plugin command list (read-only copy).
 */
export function getPluginCommands(): ReadonlyArray<CommandItem> {
  return pluginCommands;
}

// ============ Protocol building ============

export type SyncInformationPayload = {
  syncType: number;
  botVersion: string;
  pluginVersion: string;
  commandData: {
    botCommands: Array<{ name: string; description: string }>;
    pluginCommands: Array<{ name: string; description: string }>;
  };
};

/**
 * Build SyncInformationReq payload (sync_type=COMMANDS).
 *
 * - bot_commands: dynamically fetched from OpenClaw framework via listChatCommandsForConfig / listChatCommands
 * - plugin_commands: dynamically collected from plugin registration phase
 */
export async function buildSyncCommandsPayload(
  config?: OpenClawConfig,
): Promise<SyncInformationPayload> {
  const botVersion = getOpenclawVersion() || "0.0.0";
  const pluginVersion = getPluginVersion() || "0.0.0";

  const rawBotCommands = await fetchBotCommands(config);
  const botCommands = rawBotCommands ? toBotCommandItems(rawBotCommands) : [];

  return {
    syncType: SYNC_INFORMATION_TYPE.COMMANDS,
    botVersion,
    pluginVersion,
    commandData: {
      botCommands: botCommands.map((c) => ({ name: c.name, description: c.description })),
      pluginCommands: pluginCommands.map((c) => ({ name: c.name, description: c.description })),
    },
  };
}
