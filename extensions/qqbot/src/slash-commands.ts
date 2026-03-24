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

import { execFileSync, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveCredentialBackup } from "./credential-backup.js";
import type { QQBotAccountConfig } from "./types.js";
import { getUpdateInfo, checkVersionExists } from "./update-checker.js";
import { debugLog, debugError } from "./utils/debug-log.js";
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

// 获取 openclaw 框架版本（缓存结果，只执行一次）
let _frameworkVersion: string | null = null;
function getFrameworkVersion(): string {
  if (_frameworkVersion !== null) return _frameworkVersion;
  try {
    // 先尝试 PATH 中的 CLI
    // Windows 上 npm 安装的 CLI 通常是 .cmd wrapper，execFileSync 需要 shell:true 才能执行
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      try {
        const out = execFileSync(cli, ["--version"], {
          timeout: 3000,
          encoding: "utf8",
          ...(isWindows() ? { shell: true } : {}),
        }).trim();
        // 输出格式: "OpenClaw 2026.3.13 (61d171a)"
        if (out) {
          _frameworkVersion = out;
          return _frameworkVersion;
        }
      } catch {
        continue;
      }
    }
    // 尝试 findCli() 找到的完整路径
    const cliPath = findCli();
    if (cliPath) {
      const out = execCliSync(cliPath, ["--version"]);
      if (out) {
        _frameworkVersion = out;
        return _frameworkVersion;
      }
    }
  } catch {
    // fallback
  }
  _frameworkVersion = "unknown";
  return _frameworkVersion;
}

// ============ 热更新兼容性检查 ============

/**
 * 热更新可执行的环境要求：
 * - 最低 OpenClaw 框架版本
 * - 支持的操作系统
 * - 最低 Node.js 版本
 */
const UPGRADE_REQUIREMENTS = {
  /** OpenClaw 最低版本（YYYY.M.D 格式，如 "2026.3.10"） */
  minFrameworkVersion: "2026.3.2",
  /** 支持的操作系统列表（process.platform 值） */
  supportedPlatforms: ["darwin", "linux", "win32"] as string[],
  /** 最低 Node.js 版本 */
  minNodeVersion: "18.0.0",
};

interface UpgradeCompatResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 解析框架版本字符串中的日期版本号
 * 输入示例: "OpenClaw 2026.3.13 (61d171a)" → "2026.3.13"
 */
function parseFrameworkDateVersion(versionStr: string): string | null {
  const m = versionStr.match(/(\d{4}\.\d{1,2}\.\d{1,2})/);
  return m ? m[1] : null;
}

/**
 * 比较 YYYY.M.D 格式的版本号
 * @returns >0 if a > b, <0 if a < b, 0 if equal
 */
function compareDateVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 比较 semver 版本号（简化版，仅比较 major.minor.patch）
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 检查当前环境是否满足热更新要求
 */
function checkUpgradeCompatibility(): UpgradeCompatResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const req = UPGRADE_REQUIREMENTS;

  // 1. 检查操作系统
  const platform = process.platform;
  if (!req.supportedPlatforms.includes(platform)) {
    const supported = req.supportedPlatforms
      .map((p) => {
        if (p === "darwin") return "macOS";
        if (p === "linux") return "Linux";
        if (p === "win32") return "Windows";
        return p;
      })
      .join("、");
    const current = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform;
    errors.push(`❌ 当前操作系统 **${current}** 不支持热更新（支持：${supported}）`);
  }

  // 2. 检查 OpenClaw 框架版本
  const fwVersion = getFrameworkVersion();
  if (fwVersion === "unknown") {
    // 打包环境（HoldClaw/QQAIO）中 CLI 可能不在 PATH，版本检测会失败，
    // 但 findCli() 的 fallback 仍可能找到 CLI 执行升级，所以只是警告不阻断。
    warnings.push(`⚠️ 无法检测 OpenClaw 框架版本，热更新可能失败`);
  } else {
    const dateVer = parseFrameworkDateVersion(fwVersion);
    if (dateVer && compareDateVersions(dateVer, req.minFrameworkVersion) < 0) {
      errors.push(
        `❌ OpenClaw 框架版本过低：当前 **${dateVer}**，热更新要求最低 **${req.minFrameworkVersion}**。请先升级框架：\`openclaw upgrade\``,
      );
    }
  }

  // 3. 检查 Node.js 版本
  const nodeVer = process.version.replace(/^v/, "");
  if (compareSemver(nodeVer, req.minNodeVersion) < 0) {
    errors.push(
      `❌ Node.js 版本过低：当前 **v${nodeVer}**，热更新要求最低 **v${req.minNodeVersion}**`,
    );
  }

  // 4. 检查系统架构（arm 等特殊架构提示）
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    warnings.push(`⚠️ 当前 CPU 架构 **${arch}** 未经充分测试，热更新可能存在兼容性问题`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

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
 * /bot-version — 查看插件版本号
 */
registerCommand({
  name: "bot-version",
  description: "查看插件版本号",
  usage: [
    `/bot-version`,
    ``,
    `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`,
    `同时检查是否有新版本可用。`,
  ].join("\n"),
  handler: async () => {
    const frameworkVersion = getFrameworkVersion();
    const lines = [`🦞框架版本：${frameworkVersion}`, `🤖QQBot 插件版本：v${PLUGIN_VERSION}`];
    const info = await getUpdateInfo();
    if (info.checkedAt === 0) {
      lines.push(`⏳ 版本检查中...`);
    } else if (info.error) {
      lines.push(`⚠️ 版本检查失败`);
    } else if (info.hasUpdate && info.latest) {
      lines.push(
        `🆕最新可用版本：v${info.latest}，点击 <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> 查看升级指引`,
      );
    }
    lines.push(
      `🌟官方 GitHub 仓库：[点击前往](https://github.com/tencent-connect/openclaw-qqbot/)`,
    );
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
    lines.push(``, `> 插件版本 v${PLUGIN_VERSION}`);
    return lines.join("\n");
  },
});

const DEFAULT_UPGRADE_URL =
  "https://doc.weixin.qq.com/doc/w3_AKEAGQaeACgCNHrh1CbHzTAKtT2gB?scode=AJEAIQdfAAozxFEnLZAKEAGQaeACg";

function saveUpgradeGreetingTarget(accountId: string, appId: string, openid: string): void {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(
    getQQBotDataDir("data"),
    `upgrade-greeting-target-${safeAccountId}-${safeAppId}.json`,
  );
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        accountId,
        appId,
        openid,
        savedAt: new Date().toISOString(),
      }) + "\n",
    );
  } catch {
    // ignore
  }
}

// ============ 热更新 ============

/**
 * 找到 CLI 命令名或完整路径（openclaw / clawdbot / moltbot）
 *
 * 查找策略：
 * 1. 系统 PATH（where / which）
 * 2. 打包环境（HoldClaw / QQAIO）：从当前文件路径向上推断 CLI 位置
 * 3. ~/.openclaw/bin/ 等常见安装路径
 */
function findCli(): string | null {
  const whichCmd = isWindows() ? "where" : "which";
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    try {
      const out = execFileSync(whichCmd, [cli], {
        timeout: 3000,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      // where 在 Windows 上可能返回多行（多个匹配），取第一行
      const resolved = out.split(/\r?\n/)[0]?.trim();
      return resolved || cli;
    } catch {
      continue;
    }
  }

  // 打包环境 fallback：从当前文件路径推断 CLI
  // 典型路径: .../gateway/node_modules/openclaw-qqbot/dist/src/slash-commands.js
  // CLI 位于: .../gateway/node_modules/openclaw/openclaw.mjs
  // 或者:     .../gateway/node_modules/.bin/openclaw
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);

    // 向上查找 node_modules 目录
    let dir = currentDir;
    for (let i = 0; i < 10; i++) {
      const basename = path.basename(dir);
      if (basename === "node_modules") {
        // 检查 .bin 下的 CLI
        for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
          const binName = isWindows() ? `${cli}.cmd` : cli;
          const binPath = path.join(dir, ".bin", binName);
          if (fs.existsSync(binPath)) return binPath;
        }
        // 检查 openclaw/openclaw.mjs（直接通过 node 调用）
        for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
          const mjsPath = path.join(dir, cli, `${cli}.mjs`);
          if (fs.existsSync(mjsPath)) return mjsPath;
        }
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }

  // ~/.openclaw/bin/ 等常见安装路径
  const homeDir = getHomeDir();
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    const ext = isWindows() ? ".exe" : "";
    const candidates = [
      path.join(homeDir, `.${cli}`, "bin", `${cli}${ext}`),
      path.join(homeDir, `.${cli}`, `${cli}${ext}`),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * 同步执行 CLI 命令。
 * 当 cliPath 是 .mjs 文件时，自动通过 process.execPath (node) 调用。
 * Windows 上对非完整路径的命令名（如 "openclaw"）启用 shell，以兼容 .cmd wrapper。
 */
function execCliSync(cliPath: string, args: string[]): string | null {
  try {
    if (cliPath.endsWith(".mjs")) {
      return (
        execFileSync(process.execPath, [cliPath, ...args], {
          timeout: 5000,
          encoding: "utf8",
          stdio: "pipe",
        }).trim() || null
      );
    }
    const needsShell =
      isWindows() &&
      !path.isAbsolute(cliPath) &&
      !cliPath.endsWith(".cmd") &&
      !cliPath.endsWith(".exe");
    return (
      execFileSync(cliPath, args, {
        timeout: 5000,
        encoding: "utf8",
        stdio: "pipe",
        ...(needsShell ? { shell: true } : {}),
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * 异步执行 CLI 命令。
 * 当 cliPath 是 .mjs 文件时，自动通过 process.execPath (node) 调用。
 * Windows 上对非完整路径的命令名启用 shell，以兼容 .cmd wrapper。
 */
function execCliAsync(
  cliPath: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
  cb: (error: Error | null, stdout: string, stderr: string) => void,
): void {
  if (cliPath.endsWith(".mjs")) {
    execFile(process.execPath, [cliPath, ...args], opts, cb);
  } else {
    const needsShell =
      isWindows() &&
      !path.isAbsolute(cliPath) &&
      !cliPath.endsWith(".cmd") &&
      !cliPath.endsWith(".exe");
    execFile(cliPath, args, { ...opts, ...(needsShell ? { shell: true } : {}) }, cb);
  }
}

/**
 * 找到升级脚本路径（兼容源码运行、dist 运行、已安装扩展目录、打包环境）
 * Windows 优先查找 .ps1，Mac/Linux 查找 .sh
 */
function getUpgradeScriptPath(): string | null {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const scriptName = isWindows() ? "upgrade-via-npm.ps1" : "upgrade-via-npm.sh";

  const candidates = [
    // 源码运行: src/slash-commands.ts → ../../scripts/
    // dist 运行: dist/src/slash-commands.js → ../../scripts/
    path.resolve(currentDir, "..", "..", "scripts", scriptName),
    // npm 安装: node_modules/@tencent-connect/openclaw-qqbot/dist/src → ../../scripts
    path.resolve(currentDir, "..", "scripts", scriptName),
    path.resolve(process.cwd(), "scripts", scriptName),
  ];

  // 向上查找包含 scripts/ 的祖先目录（适应各种嵌套深度的打包环境）
  let dir = currentDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "scripts", scriptName);
    if (!candidates.includes(candidate)) candidates.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const homeDir = getHomeDir();
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    candidates.push(
      path.join(homeDir, `.${cli}`, "extensions", "openclaw-qqbot", "scripts", scriptName),
    );
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

type HotUpgradeStartResult = {
  ok: boolean;
  reason?: "no-script" | "no-cli" | "no-bash" | "no-powershell";
};

/**
 * 在 Windows 上查找可用的 bash（Git Bash / WSL 等）
 * 仅作为 Windows 上的 fallback（优先使用 PowerShell）
 */
function findBash(): string | null {
  if (!isWindows()) return "bash";

  // Git Bash 常见路径
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Git",
      "bin",
      "bash.exe",
    ),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  // 尝试 PATH 中的 bash
  try {
    execFileSync("where", ["bash"], { timeout: 3000, encoding: "utf8", stdio: "pipe" });
    return "bash";
  } catch {
    return null;
  }
}

/**
 * 将 openclaw.json 中的 qqbot 插件 source 从 "path" 切换为 "npm"。
 * 用于热更新场景：从 npm 拉取新版本后，确保 openclaw 不再从本地源码加载。
 *
 * 安全保障：写回配置前验证 channels.qqbot 未丢失，防止竞态写入导致凭证消失。
 */
function switchPluginSourceToNpm(): void {
  try {
    const homeDir = getHomeDir();
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;

      // 读取当前配置（保留原始文本用于回退）
      const raw = fs.readFileSync(cfgPath, "utf8");

      let cfg: any;
      try {
        cfg = JSON.parse(raw);
      } catch {
        // 配置文件已经是损坏的 JSON，不要继续操作以免加剧问题
        break;
      }

      const inst = cfg?.plugins?.installs?.["openclaw-qqbot"];
      if (!inst || inst.source === "npm") {
        break; // 无需修改
      }

      // 记录修改前的完整快照，用于写后校验
      const channelsBefore = JSON.stringify(cfg.channels ?? null);

      inst.source = "npm";
      delete inst.sourcePath;
      const newRaw = JSON.stringify(cfg, null, 4) + "\n";

      // 写后校验：重新解析确认整个 JSON 合法且 channels 未被破坏
      let verify: any;
      try {
        verify = JSON.parse(newRaw);
      } catch {
        // stringify 后竟然无法 parse（理论上不会），放弃写入
        break;
      }
      const channelsAfter = JSON.stringify(verify.channels ?? null);
      if (channelsBefore !== channelsAfter) {
        // channels 数据异常，放弃写入
        break;
      }

      // 原子写入：先写临时文件，再 rename 替换，避免写入中途崩溃导致配置文件损坏
      const tmpPath = cfgPath + ".qqbot-upgrade.tmp";
      fs.writeFileSync(tmpPath, newRaw, { mode: 0o644 });

      // 再次校验临时文件的完整性
      try {
        JSON.parse(fs.readFileSync(tmpPath, "utf8"));
      } catch {
        // 写入的临时文件不完整，清理后放弃
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        break;
      }

      fs.renameSync(tmpPath, cfgPath);
      break;
    }
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 热更新前保存当前账户的 appId/secret 到暂存文件。
 * 从 openclaw.json 中直接读取 clientSecret（slash command ctx 中不含 secret）。
 */
function preUpgradeCredentialBackup(accountId: string, appId: string): void {
  try {
    const homeDir = getHomeDir();
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const qqbot = cfg?.channels?.qqbot;
      if (!qqbot) break;
      // 从默认账户或 accounts 子节点中读取 secret
      let secret = "";
      if (accountId === "default" && qqbot.clientSecret) {
        secret = qqbot.clientSecret;
      } else if (qqbot.accounts?.[accountId]?.clientSecret) {
        secret = qqbot.accounts[accountId].clientSecret;
      } else if (qqbot.clientSecret) {
        secret = qqbot.clientSecret;
      }
      if (appId && secret) {
        saveCredentialBackup(accountId, appId, secret);
      }
      break;
    }
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 在 Windows 上查找 PowerShell（pwsh 优先，powershell.exe 兜底）
 */
function findPowerShell(): string | null {
  // pwsh = PowerShell 7+（跨平台），powershell.exe = Windows 内置 5.1
  for (const ps of ["pwsh", "powershell"]) {
    try {
      execFileSync("where", [ps], { timeout: 3000, encoding: "utf8", stdio: "pipe" });
      return ps;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 执行热更新：执行脚本(--no-restart) → 立即触发 gateway restart
 *
 * fire-and-forget 操作：
 * - 异步执行升级脚本（--no-restart / -NoRestart，只做文件替换）
 * - 脚本完成后**立即**触发 gateway restart（当前进程会被杀掉）
 * - 新进程启动时 getStartupGreeting() 检测到版本变更，自动通知管理员
 *
 * Windows 使用 PowerShell 执行 .ps1 脚本，Mac/Linux 使用 bash 执行 .sh 脚本。
 */
function fireHotUpgrade(targetVersion?: string): HotUpgradeStartResult {
  const scriptPath = getUpgradeScriptPath();
  if (!scriptPath) return { ok: false, reason: "no-script" };

  const cli = findCli();
  if (!cli) return { ok: false, reason: "no-cli" };

  let shell: string;
  let shellArgs: string[];

  if (isWindows()) {
    // Windows: PowerShell 执行 .ps1
    const ps = findPowerShell();
    if (!ps) return { ok: false, reason: "no-powershell" };
    shell = ps;
    shellArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-NoRestart",
      ...(targetVersion ? ["-Version", targetVersion] : []),
    ];
  } else {
    // Mac / Linux: bash 执行 .sh
    const bash = findBash();
    if (!bash) return { ok: false, reason: "no-bash" };
    shell = bash;
    shellArgs = [
      scriptPath,
      "--no-restart",
      ...(targetVersion ? ["--version", targetVersion] : []),
    ];
  }

  debugLog(
    `[qqbot] fireHotUpgrade: shell=${shell}, script=${scriptPath}, cli=${cli}, target=${targetVersion || "latest"}`,
  );

  // 异步执行升级脚本
  execFile(
    shell,
    shellArgs,
    {
      timeout: 120_000,
      env: { ...process.env },
      ...(isWindows() ? { windowsHide: true } : {}),
    },
    (error, stdout, _stderr) => {
      if (error) {
        debugError(`[qqbot] fireHotUpgrade: script failed: ${error.message}`);
        if (stdout) debugError(`[qqbot] fireHotUpgrade: stdout: ${stdout.slice(0, 2000)}`);
        if (_stderr) debugError(`[qqbot] fireHotUpgrade: stderr: ${_stderr.slice(0, 2000)}`);
        _upgrading = false;
        return;
      }

      debugLog(`[qqbot] fireHotUpgrade: script completed, stdout length=${stdout.length}`);

      // 从脚本输出中提取版本号，验证文件替换是否成功
      const versionMatch = stdout.match(/QQBOT_NEW_VERSION=(\S+)/);
      const newVersion = versionMatch?.[1];
      if (newVersion === "unknown") {
        debugError(
          `[qqbot] fireHotUpgrade: script output QQBOT_NEW_VERSION=unknown, aborting restart`,
        );
        _upgrading = false;
        return;
      }

      debugLog(
        `[qqbot] fireHotUpgrade: new version=${newVersion || "(not detected)"}, triggering restart...`,
      );

      // 文件替换成功，在 restart 之前把 source 从 path 切换为 npm，
      // 确保新进程启动时读到的是 npm source，不会被本地源码覆盖。
      switchPluginSourceToNpm();

      if (isWindows()) {
        // Windows: 启动一个分离的 PowerShell 进程来执行 stop → 等待 → start
        // 这样当前 Node 进程被 stop 杀掉后，PowerShell 进程仍能继续执行 start
        // 使用 PowerShell 而非 bat，因为 cli 可能是 .mjs 文件需要通过 node 调用
        const cliInvoke = cli.endsWith(".mjs") ? `& '${process.execPath}' '${cli}'` : `& '${cli}'`;
        const ps1Content = [
          `Write-Host '[qqbot-upgrade] Stopping gateway...'`,
          `${cliInvoke} gateway stop`,
          `Write-Host '[qqbot-upgrade] Waiting for process to exit...'`,
          `Start-Sleep -Seconds 3`,
          `Write-Host '[qqbot-upgrade] Starting gateway...'`,
          `${cliInvoke} gateway start`,
          `Write-Host '[qqbot-upgrade] Done.'`,
          `Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue`,
        ].join("\r\n");
        const ps1Path = path.join(getHomeDir(), ".openclaw", ".qqbot-restart.ps1");
        const ps = findPowerShell();
        try {
          fs.writeFileSync(ps1Path, ps1Content, "utf8");
          // spawn with detached:true + stdio:"ignore" → 真正的独立进程，不受父进程树终止影响
          const child = spawn(
            ps || "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
            {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
            },
          );
          child.unref();
          debugLog(
            `[qqbot] fireHotUpgrade: launched detached restart script (pid=${child.pid}): ${ps1Path}`,
          );
        } catch (psErr: any) {
          debugError(
            `[qqbot] fireHotUpgrade: failed to launch ps1 restart: ${psErr.message}, falling back to direct restart`,
          );
          execCliAsync(cli, ["gateway", "restart"], { timeout: 30_000 }, () => {});
        }
      } else {
        // Mac/Linux: 直接 restart（框架通常以 daemon 模式运行）
        execCliAsync(cli, ["gateway", "restart"], { timeout: 30_000 }, (restartErr) => {
          if (restartErr) {
            debugError(
              `[qqbot] fireHotUpgrade: restart failed: ${restartErr.message}, trying stop+start fallback`,
            );
            execCliAsync(cli, ["gateway", "stop"], { timeout: 10_000 }, () => {
              setTimeout(() => {
                execCliAsync(cli, ["gateway", "start"], { timeout: 30_000 }, () => {});
              }, 1000);
            });
          }
        });
      }
    },
  );

  return { ok: true };
}

/**
 * /bot-upgrade — 统一升级入口
 *
 * 产品流程：
 *   /bot-upgrade              — 展示版本信息+确认按钮（不直接升级）
 *   /bot-upgrade --latest     — 确认升级到最新版本
 *   /bot-upgrade --version X  — 升级到指定版本
 *   /bot-upgrade --force      — 强制升级（即使当前已是最新版）
 */
let _upgrading = false; // 升级锁

registerCommand({
  name: "bot-upgrade",
  description: "检查更新并自动热更",
  usage: [
    `/bot-upgrade              检查是否有新版本（展示信息+确认按钮）`,
    `/bot-upgrade --latest     确认升级到最新版本`,
    `/bot-upgrade --version X  升级到指定版本（如 1.6.5）`,
    `/bot-upgrade --force      强制重新安装当前版本`,
    ``,
    `⚠️ 仅在私聊中可用。升级过程约 30~60 秒，期间服务短暂不可用。`,
    ``,
    `环境要求：`,
    `  - 操作系统：macOS / Linux / Windows`,
    `  - OpenClaw 框架版本 ≥ ${UPGRADE_REQUIREMENTS.minFrameworkVersion}`,
    `  - Node.js ≥ v${UPGRADE_REQUIREMENTS.minNodeVersion}`,
  ].join("\n"),
  handler: async (ctx) => {
    // 升级相关指令仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    // 升级锁：防止重复触发
    if (_upgrading) {
      return `⏳ 正在升级中，请稍候...`;
    }

    const url = ctx.accountConfig?.upgradeUrl || DEFAULT_UPGRADE_URL;
    const args = ctx.args.trim();
    const info = await getUpdateInfo();

    let isForce = false;
    let isLatest = false;
    let versionArg: string | undefined;
    const tokens = args ? args.split(/\s+/).filter(Boolean) : [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (t === "--force") {
        isForce = true;
        continue;
      }
      if (t === "--latest") {
        isLatest = true;
        continue;
      }
      if (t === "--version") {
        const next = tokens[i + 1];
        if (!next || next.startsWith("--")) {
          return `❌ 参数错误：--version 需要版本号\n\n示例：/bot-upgrade --version 1.6.5`;
        }
        versionArg = next.replace(/^v/, "");
        i += 1;
        continue;
      }
      if (t.startsWith("--version=")) {
        const v = t.slice("--version=".length).trim();
        if (!v) {
          return `❌ 参数错误：--version 需要版本号\n\n示例：/bot-upgrade --version 1.6.5`;
        }
        versionArg = v.replace(/^v/, "");
        continue;
      }
      if (!t.startsWith("--") && !versionArg) {
        versionArg = t.replace(/^v/, "");
        continue;
      }
    }

    const GITHUB_URL = "https://github.com/tencent-connect/openclaw-qqbot/";

    // ── 无参数（也没有 --latest / --version / --force）：只展示信息+确认按钮 ──
    if (!versionArg && !isLatest && !isForce) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate) {
        const lines = [
          `✅ 当前已是最新版本 v${PLUGIN_VERSION}`,
          ``,
          `项目地址：[GitHub](${GITHUB_URL})`,
        ];
        return lines.join("\n");
      }

      // 有新版本：展示信息 + 确认按钮（同通道：alpha 只展示 alpha，正式版只展示正式版）
      return [
        `🆕 发现新版本`,
        ``,
        `当前版本：**v${PLUGIN_VERSION}**`,
        `最新版本：**v${info.latest}**`,
        ``,
        `升级将重启 Gateway 服务，期间短暂不可用。`,
        `请确认主机网络可正常访问 npm 仓库。`,
        ``,
        `**点击确认升级** <qqbot-cmd-enter text="/bot-upgrade --latest" />`,
        ``,
        `手动升级指引：[点击查看](${url})`,
        `🌟官方 GitHub 仓库：[点击前往](${GITHUB_URL})`,
      ].join("\n");
    }

    // ── --version 指定版本：先校验版本号是否存在 ──
    if (versionArg) {
      const exists = await checkVersionExists(versionArg);
      if (!exists) {
        return `❌ 版本 ${versionArg} 不存在，请检查版本号`;
      }

      // 检查是否就是当前版本
      if (versionArg === PLUGIN_VERSION && !isForce) {
        return `✅ 当前已是 v${PLUGIN_VERSION}，无需升级`;
      }
    }

    // ── --latest：检查是否需要升级 ──
    if (isLatest && !versionArg) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate && !isForce) {
        return `✅ 当前已是 v${PLUGIN_VERSION}，无需升级`;
      }
    }

    const targetVersion = versionArg || info.latest || undefined;

    // --force 时如果 targetVersion 等于当前版本，属于强制重装
    const isReinstall = isForce && targetVersion === PLUGIN_VERSION;

    // ── 环境兼容性检查 ──
    const compat = checkUpgradeCompatibility();
    if (!compat.ok) {
      return [
        `🚫 当前环境不满足热更新要求：`,
        ``,
        ...compat.errors,
        ...(compat.warnings.length ? [``, ...compat.warnings] : []),
        ``,
        `查看手动升级指引：[点击查看](${url})`,
      ].join("\n");
    }

    // 加锁
    _upgrading = true;

    // 热更新前保存凭证快照，防止更新过程被打断导致 appId/secret 丢失
    preUpgradeCredentialBackup(ctx.accountId, ctx.appId);

    // 异步执行升级
    const startResult = fireHotUpgrade(targetVersion);
    if (!startResult.ok) {
      _upgrading = false;
      if (startResult.reason === "no-script") {
        return [
          `❌ 未找到升级脚本，无法执行热更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (startResult.reason === "no-cli") {
        return [
          `❌ 未找到 CLI 工具，无法执行热更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (startResult.reason === "no-powershell") {
        return [
          `❌ 未找到 PowerShell，无法执行热更新`,
          ``,
          `请确认系统中已安装 PowerShell（Windows 10+ 自带）`,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      return [
        `❌ 当前环境不支持热更新（需要 bash）`,
        ``,
        `查看手动升级指引：[点击查看](${url})`,
      ].join("\n");
    }

    saveUpgradeGreetingTarget(ctx.accountId, ctx.appId, ctx.senderId);

    const resultLines = isReinstall
      ? [`🔄 正在重新安装 v${PLUGIN_VERSION}...`, ``, `预计 30~60 秒完成，届时会自动通知您`]
      : [
          `🔄 正在升级...`,
          ``,
          `当前版本：v${PLUGIN_VERSION}`,
          ...(targetVersion ? [`目标版本：v${targetVersion}`] : []),
          ``,
          `预计 30~60 秒完成，届时会自动通知您`,
        ];
    return resultLines.join("\n");
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
