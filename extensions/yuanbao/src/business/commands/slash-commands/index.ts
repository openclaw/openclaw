/**
 * 快捷命令注册表
 *
 * 维护 Bot 单聊场景下可用的 /命令 列表。
 * 按协议拆分为 bot_commands（OpenClaw 内置）和 plugin_commands（插件提供）。
 *
 * - plugin_commands：从插件注册阶段动态收集（registerPluginCommand）
 * - bot_commands：通过 openclaw/plugin-sdk/command-auth 的 listChatCommands 动态获取
 *
 * 使用方式：
 *   import { buildSyncCommandsPayload } from './commands/slash-commands/index.js';
 *   const payload = buildSyncCommandsPayload(config);
 *   await client.syncInformation(payload);
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getPluginVersion, getOpenclawVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";

// ============ 动态加载 command-auth（兼容旧版 OpenClaw） ============

/**
 * openclaw/plugin-sdk/command-auth 在较新版本（>= 2026.4）才可用。
 * 旧版 OpenClaw（如 2026.3.x）没有这个模块，静态 import 会导致插件加载失败。
 * 因此改为运行时 import() 动态加载，失败时降级返回兜底列表。
 *
 * 注意：项目是 ESM（"type": "module"），必须用 import() 而非 require()。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _listChatCommands: ((options?: any) => any[]) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _listChatCommandsForConfig: ((cfg: any, options?: any) => any[]) | null = null;
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

// ============ 类型 ============

export type CommandItem = {
  /** 命令名（含 /），如 "/help" */
  name: string;
  /** 命令说明 */
  description: string;
};

/** openclaw/plugin-sdk/command-auth 返回的命令定义（使用 any 避免与 SDK 内部类型冲突） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ChatCommandDef = any;

// ============ SyncInformation 协议常量 ============

export const SYNC_INFORMATION_TYPE = {
  UNSPECIFIED: 0,
  COMMANDS: 1,
} as const;

// ============ bot_commands：从 OpenClaw SDK 动态获取 ============

/**
 * 兜底命令列表：当 command-auth 模块不可用（旧版 OpenClaw）时使用。
 * 包含已知的常用 OpenClaw 框架内置命令。
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
 * 获取全量 OpenClaw 框架命令列表。
 *
 * 优先通过 command-auth 模块动态获取（新版 OpenClaw >= 2026.4），
 * 旧版 OpenClaw 不支持时降级为兜底列表。
 *
 * @param config - OpenClaw 配置（可选）
 * @returns 命令列表
 */
async function fetchBotCommands(config?: OpenClawConfig): Promise<ChatCommandDef[] | null> {
  const log = createLog("slash-commands");

  await loadCommandAuth();

  if (!_listChatCommandsForConfig && !_listChatCommands) {
    log.info(
      `command-auth 模块不可用（旧版 OpenClaw），使用兜底命令列表: ${FALLBACK_BOT_COMMANDS.length} 个命令`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return FALLBACK_BOT_COMMANDS as any[];
  }

  try {
    if (config && _listChatCommandsForConfig) {
      const commands = _listChatCommandsForConfig(config);
      log.debug(`使用配置感知版本获取命令列表: ${commands.length} 个命令`);
      if (commands.length > 0) {
        log.debug("命令原始结构示例:", {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sample: commands.slice(0, 3).map((c: any) => ({
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
 * 将 ChatCommandDefinition[] 转换为 CommandItem[]
 *
 * listChatCommandsForConfig 返回的命令对象可能有多种字段名：
 * - name: 命令名（可能不含 /）
 * - textAliases: 文本别名数组（如 ["/help", "/commands"]）
 * - description: 命令描述
 */
function toBotCommandItems(commands: ChatCommandDef[]): CommandItem[] {
  const log = createLog("slash-commands");
  const result: CommandItem[] = [];

  for (const cmd of commands) {
    // 优先取 textAliases 中的第一个（通常是主命令名，含 /）
    const aliases = cmd.textAliases as string[] | undefined;
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

// ============ plugin_commands：动态收集 ============

/**
 * 插件注册的命令列表（运行时动态收集）。
 *
 * 在 channel.ts 的 register() 中每次调用 api.registerCommand 后，
 * 同步调用 registerPluginCommand 将命令信息记录到此列表。
 */
const pluginCommands: CommandItem[] = [];

/**
 * 注册一个插件命令到同步列表。
 * 在 channel.ts 的 plugin.register() 中调用，与 api.registerCommand 配对使用。
 *
 * @param name - 命令名（不含 /），如 "yuanbaobot-upgrade"
 * @param description - 命令描述
 */
export function registerPluginCommand(name: string, description: string): void {
  const fullName = name.startsWith("/") ? name : `/${name}`;
  // 去重
  if (!pluginCommands.some((c) => c.name === fullName)) {
    pluginCommands.push({ name: fullName, description });
  }
}

/**
 * 获取已注册的插件命令列表（只读副本）
 */
export function getPluginCommands(): ReadonlyArray<CommandItem> {
  return pluginCommands;
}

// ============ 协议构建 ============

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
 * 构建 SyncInformationReq 的 payload（sync_type=COMMANDS）
 *
 * - bot_commands: 通过 listChatCommandsForConfig / listChatCommands 从 OpenClaw 框架动态获取
 * - plugin_commands: 从插件注册阶段动态收集的命令列表
 *
 * @param config - OpenClaw 配置（可选，用于获取配置感知的命令列表）
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
