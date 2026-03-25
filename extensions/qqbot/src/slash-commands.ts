/**
 * QQBot 插件级斜杠指令处理器
 *
 * 设计原则：
 * 1. 在消息入队前拦截，匹配到插件级指令后直接回复，不进入 AI 处理队列
 * 2. 不匹配的 "/" 消息照常入队，交给 OpenClaw 框架处理
 * 3. 每个指令通过 SlashCommand 接口注册，易于扩展
 *
 * 时间线追踪：
 *   开平推送时间戳 → 插件收到(Date.now()) → 指令处理完成(Date.now())
 *   从而计算「开平→插件」和「插件处理」两段耗时
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveRuntimeServiceVersion } from "openclaw/plugin-sdk/cli-runtime";
import type { QQBotAccountConfig } from "./types.js";
import { debugLog } from "./utils/debug-log.js";
import { getHomeDir, getQQBotDataDir, isWindows } from "./utils/platform.js";
const require = createRequire(import.meta.url);

// 读取 package.json 中的版本号
let PLUGIN_VERSION = "unknown";
try {
  const pkg = require("../package.json");
  PLUGIN_VERSION = pkg.version ?? "unknown";
} catch {
  // fallback
}

const QQBOT_PLUGIN_GITHUB_URL = "https://github.com/openclaw/openclaw/tree/main/extensions/qqbot";

// ============ 类型定义 ============

/** 斜杠指令上下文（消息元数据 + 运行时状态） */
export interface SlashCommandContext {
  /** 消息类型 */
  type: "c2c" | "guild" | "dm" | "group";
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderName?: string;
  /** 消息 ID（用于被动回复） */
  messageId: string;
  /** 开平推送的事件时间戳（ISO 字符串） */
  eventTimestamp: string;
  /** 插件收到消息的本地时间（ms） */
  receivedAt: number;
  /** 原始消息内容 */
  rawContent: string;
  /** 指令参数（去掉指令名后的部分） */
  args: string;
  /** 频道 ID（guild 类型） */
  channelId?: string;
  /** 群 openid（group 类型） */
  groupOpenid?: string;
  /** 账号 ID */
  accountId: string;
  /** Bot App ID */
  appId: string;
  /** 账号配置（供指令读取可配置项） */
  accountConfig?: QQBotAccountConfig;
  /** 当前用户队列状态快照 */
  queueSnapshot: QueueSnapshot;
}

/** 队列状态快照 */
export interface QueueSnapshot {
  /** 各用户队列中的消息总数 */
  totalPending: number;
  /** 正在并行处理的用户数 */
  activeUsers: number;
  /** 最大并发用户数 */
  maxConcurrentUsers: number;
  /** 当前发送者在队列中的待处理消息数 */
  senderPending: number;
}

/** 斜杠指令返回值：文本、带文件的结果、或 null（不处理） */
export type SlashCommandResult = string | SlashCommandFileResult | null;

/** 带文件的指令结果（先回复文本，再发送文件） */
export interface SlashCommandFileResult {
  text: string;
  /** 要发送的本地文件路径 */
  filePath: string;
}

/** 斜杠指令定义 */
interface SlashCommand {
  /** 指令名（不含 /） */
  name: string;
  /** 简要描述 */
  description: string;
  /** 详细用法说明（支持多行），用于 /指令 ? 查询 */
  usage?: string;
  /** 处理函数 */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

// ============ 指令注册表 ============

const commands: Map<string, SlashCommand> = new Map();

function registerCommand(cmd: SlashCommand): void {
  commands.set(cmd.name.toLowerCase(), cmd);
}

// ============ 内置指令 ============

/**
 * /bot-ping — 测试当前 openclaw 与 QQ 连接的网络延迟
 */
registerCommand({
  name: "bot-ping",
  description: "测试当前 openclaw 与 QQ 连接的网络延迟",
  usage: [
    `/bot-ping`,
    ``,
    `测试 OpenClaw 主机与 QQ 服务器之间的网络延迟。`,
    `返回网络传输耗时和插件处理耗时。`,
  ].join("\n"),
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    if (isNaN(eventTime)) {
      return `✅ pong!`;
    }
    const totalMs = now - eventTime;
    const qqToPlugin = ctx.receivedAt - eventTime;
    const pluginProcess = now - ctx.receivedAt;
    const lines = [
      `✅ pong！`,
      ``,
      `⏱ 延迟: ${totalMs}ms`,
      `  ├ 网络传输: ${qqToPlugin}ms`,
      `  └ 插件处理: ${pluginProcess}ms`,
    ];
    return lines.join("\n");
  },
});

/**
 * /bot-version — 查看框架版本号
 */
registerCommand({
  name: "bot-version",
  description: "查看框架版本号",
  usage: [`/bot-version`, ``, `查看当前 OpenClaw 框架版本。`].join("\n"),
  handler: async () => {
    const frameworkVersion = resolveRuntimeServiceVersion();
    const lines = [`🦞OpenClaw 版本：${frameworkVersion}`];
    lines.push(`🌟官方 GitHub 仓库：[点击前往](${QQBOT_PLUGIN_GITHUB_URL})`);
    return lines.join("\n");
  },
});

/**
 * /bot-help — 查看所有指令以及用途
 */
registerCommand({
  name: "bot-help",
  description: "查看所有指令以及用途",
  usage: [
    `/bot-help`,
    ``,
    `列出所有可用的 QQBot 插件内置指令及其简要说明。`,
    `使用 /指令名 ? 可查看某条指令的详细用法。`,
  ].join("\n"),
  handler: () => {
    const lines = [`### QQBot插件内置调试指令`, ``];
    for (const [name, cmd] of commands) {
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    return lines.join("\n");
  },
});

/**
 * 从 openclaw.json / clawdbot.json / moltbot.json 的 logging.file 配置中
 * 提取用户自定义的日志文件路径（直接文件路径，非目录）。
 */
function getConfiguredLogFiles(): string[] {
  const homeDir = getHomeDir();
  const files: string[] = [];
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    try {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const logFile = cfg?.logging?.file;
      if (logFile && typeof logFile === "string") {
        files.push(path.resolve(logFile));
      }
      break;
    } catch {
      // ignore
    }
  }
  return files;
}

/**
 * /bot-logs — 导出本地日志文件
 *
 * 日志定位策略（兼容腾讯云/各云厂商不同安装路径）：
 * 0. 优先从 openclaw.json 的 logging.file 配置中读取自定义日志路径（最精确）
 * 1. 使用 *_STATE_DIR 环境变量（OPENCLAW/CLAWDBOT/MOLTBOT）
 * 2. 扫描常见状态目录：~/.openclaw, ~/.clawdbot, ~/.moltbot 及其 logs 子目录
 * 3. 扫描 home/cwd/AppData 下名称包含 openclaw/clawdbot/moltbot 的目录
 * 4. 扫描 /var/log 下的 openclaw/clawdbot/moltbot 目录
 * 5. 在候选目录中选取最近更新的日志文件（gateway/openclaw/clawdbot/moltbot）
 */
function collectCandidateLogDirs(): string[] {
  const homeDir = getHomeDir();
  const dirs = new Set<string>();

  const pushDir = (p?: string) => {
    if (!p) return;
    const normalized = path.resolve(p);
    dirs.add(normalized);
  };

  const pushStateDir = (stateDir?: string) => {
    if (!stateDir) return;
    pushDir(stateDir);
    pushDir(path.join(stateDir, "logs"));
  };

  // 0. 从配置文件的 logging.file 提取目录
  for (const logFile of getConfiguredLogFiles()) {
    pushDir(path.dirname(logFile));
  }

  // 1. 环境变量 *_STATE_DIR
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/STATE_DIR$/i.test(key) && /(OPENCLAW|CLAWDBOT|MOLTBOT)/i.test(key)) {
      pushStateDir(value);
    }
  }

  // 2. 常见状态目录
  for (const name of [".openclaw", ".clawdbot", ".moltbot", "openclaw", "clawdbot", "moltbot"]) {
    pushDir(path.join(homeDir, name));
    pushDir(path.join(homeDir, name, "logs"));
  }

  // 3. home/cwd/AppData 下包含 openclaw/clawdbot/moltbot 的子目录
  const searchRoots = new Set<string>([homeDir, process.cwd(), path.dirname(process.cwd())]);
  if (process.env.APPDATA) searchRoots.add(process.env.APPDATA);
  if (process.env.LOCALAPPDATA) searchRoots.add(process.env.LOCALAPPDATA);

  for (const root of searchRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/(openclaw|clawdbot|moltbot)/i.test(entry.name)) continue;
        const base = path.join(root, entry.name);
        pushDir(base);
        pushDir(path.join(base, "logs"));
      }
    } catch {
      // 无权限或不存在，跳过
    }
  }

  // 4. /var/log 下的常见日志目录（Linux 服务器部署场景）
  if (!isWindows()) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join("/var/log", name));
    }
  }

  // 5. /tmp 和系统临时目录下的日志（gateway 默认日志路径可能在 /tmp/openclaw/）
  const tmpRoots = new Set<string>();
  if (isWindows()) {
    // Windows: C:\tmp, %TEMP%, %LOCALAPPDATA%\Temp
    tmpRoots.add("C:\\tmp");
    if (process.env.TEMP) tmpRoots.add(process.env.TEMP);
    if (process.env.TMP) tmpRoots.add(process.env.TMP);
    if (process.env.LOCALAPPDATA) tmpRoots.add(path.join(process.env.LOCALAPPDATA, "Temp"));
  } else {
    tmpRoots.add("/tmp");
  }
  for (const tmpRoot of tmpRoots) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join(tmpRoot, name));
    }
  }

  return Array.from(dirs);
}

type LogCandidate = {
  filePath: string;
  sourceDir: string;
  mtimeMs: number;
};

function collectRecentLogFiles(logDirs: string[]): LogCandidate[] {
  const candidates: LogCandidate[] = [];
  const dedupe = new Set<string>();

  const pushFile = (filePath: string, sourceDir: string) => {
    const normalized = path.resolve(filePath);
    if (dedupe.has(normalized)) return;
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) return;
      dedupe.add(normalized);
      candidates.push({ filePath: normalized, sourceDir, mtimeMs: stat.mtimeMs });
    } catch {
      // 文件不存在或无权限
    }
  };

  // 优先级最高：用户在 openclaw.json logging.file 中显式配置的日志文件
  for (const logFile of getConfiguredLogFiles()) {
    pushFile(logFile, path.dirname(logFile));
  }

  for (const dir of logDirs) {
    pushFile(path.join(dir, "gateway.log"), dir);
    pushFile(path.join(dir, "gateway.err.log"), dir);
    pushFile(path.join(dir, "openclaw.log"), dir);
    pushFile(path.join(dir, "clawdbot.log"), dir);
    pushFile(path.join(dir, "moltbot.log"), dir);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(log|txt)$/i.test(entry.name)) continue;
        if (!/(gateway|openclaw|clawdbot|moltbot)/i.test(entry.name)) continue;
        pushFile(path.join(dir, entry.name), dir);
      }
    } catch {
      // 无权限或不存在，跳过
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

registerCommand({
  name: "bot-logs",
  description: "导出本地日志文件",
  usage: [
    `/bot-logs`,
    ``,
    `导出最近的 OpenClaw 日志文件（最多 4 个）。`,
    `每个文件最多保留最后 1000 行，以文件形式返回。`,
  ].join("\n"),
  handler: () => {
    const logDirs = collectCandidateLogDirs();
    const recentFiles = collectRecentLogFiles(logDirs).slice(0, 4);

    if (recentFiles.length === 0) {
      const existingDirs = logDirs.filter((d) => {
        try {
          return fs.existsSync(d);
        } catch {
          return false;
        }
      });
      const searched =
        existingDirs.length > 0
          ? existingDirs.map((d) => `  • ${d}`).join("\n")
          : logDirs
              .slice(0, 6)
              .map((d) => `  • ${d}`)
              .join("\n") + (logDirs.length > 6 ? `\n  …及其他 ${logDirs.length - 6} 个路径` : "");
      return [
        `⚠️ 未找到日志文件`,
        ``,
        `已搜索以下${existingDirs.length > 0 ? "已存在的" : ""}路径：`,
        searched,
        ``,
        `💡 如果日志在自定义路径，请在配置文件中添加：`,
        `  "logging": { "file": "/path/to/your/logfile.log" }`,
      ].join("\n");
    }

    const lines: string[] = [];
    let totalIncluded = 0;
    let totalOriginal = 0;
    let truncatedCount = 0;
    const MAX_LINES_PER_FILE = 1000;
    for (const logFile of recentFiles) {
      try {
        const content = fs.readFileSync(logFile.filePath, "utf8");
        const allLines = content.split("\n");
        const totalFileLines = allLines.length;
        const tail = allLines.slice(-MAX_LINES_PER_FILE);
        if (tail.length > 0) {
          const fileName = path.basename(logFile.filePath);
          lines.push(
            `\n========== ${fileName} (last ${tail.length} of ${totalFileLines} lines) ==========`,
          );
          lines.push(`from: ${logFile.sourceDir}`);
          lines.push(...tail);
          totalIncluded += tail.length;
          totalOriginal += totalFileLines;
          if (totalFileLines > MAX_LINES_PER_FILE) truncatedCount++;
        }
      } catch {
        lines.push(`[读取 ${path.basename(logFile.filePath)} 失败]`);
      }
    }

    if (lines.length === 0) {
      return `⚠️ 找到日志文件但读取失败，请检查文件权限`;
    }

    const tmpDir = getQQBotDataDir("downloads");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}.txt`);
    fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

    const fileCount = recentFiles.length;
    const topSources = Array.from(new Set(recentFiles.map((item) => item.sourceDir))).slice(0, 3);
    // 紧凑摘要：N 个日志文件，共 X 行（如有截断则注明）
    let summaryText = `${fileCount} 个日志文件，共 ${totalIncluded} 行`;
    if (truncatedCount > 0) {
      summaryText += `（${truncatedCount} 个文件因过长仅保留最后 ${MAX_LINES_PER_FILE} 行，原始共 ${totalOriginal} 行）`;
    }
    return {
      text: `📋 ${summaryText}\n📂 来源：${topSources.join(" | ")}`,
      filePath: tmpFile,
    };
  },
});

// ============ 匹配入口 ============

/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) return null;

  // 解析指令名和参数
  const spaceIdx = content.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const cmd = commands.get(cmdName);
  if (!cmd) return null; // 不是插件级指令，交给框架

  // /指令 ? — 返回用法说明
  if (args === "?") {
    if (cmd.usage) {
      return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
    }
    return `/${cmd.name} — ${cmd.description}`;
  }

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
