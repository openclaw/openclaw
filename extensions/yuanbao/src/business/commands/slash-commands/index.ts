/** Slash command registry. */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getPluginVersion, getOpenclawVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";

// Dynamic import: command-auth may not exist in older OpenClaw versions
let _listChatCommands: ((options?: Record<string, unknown>) => ChatCommandDef[]) | null = null;
let _listChatCommandsForConfig:
  | ((cfg: Record<string, unknown>, options?: Record<string, unknown>) => ChatCommandDef[])
  | null = null;
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

export type CommandItem = {
  name: string;
  description: string;
};

type ChatCommandDef = {
  name?: string;
  description?: string;
  textAliases?: string[];
  [key: string]: unknown;
};

export const SYNC_INFORMATION_TYPE = {
  UNSPECIFIED: 0,
  COMMANDS: 1,
} as const;

const FALLBACK_BOT_COMMANDS: CommandItem[] = [
  { name: "/help", description: "Show available commands." },
  { name: "/status", description: "Show current status." },
  { name: "/stop", description: "Stop the current run." },
  { name: "/new", description: "Start a new session." },
  { name: "/restart", description: "Restart OpenClaw." },
  { name: "/compact", description: "Compact the session context." },
];

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

const pluginCommands: CommandItem[] = [];

export function registerPluginCommand(name: string, description: string): void {
  const fullName = name.startsWith("/") ? name : `/${name}`;
  // Deduplicate
  if (!pluginCommands.some((c) => c.name === fullName)) {
    pluginCommands.push({ name: fullName, description });
  }
}

export function getPluginCommands(): ReadonlyArray<CommandItem> {
  return pluginCommands;
}

export type SyncInformationPayload = {
  syncType: number;
  botVersion: string;
  pluginVersion: string;
  commandData: {
    botCommands: Array<{ name: string; description: string }>;
    pluginCommands: Array<{ name: string; description: string }>;
  };
};

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
