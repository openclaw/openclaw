/**
 * Plugin Loader — jiti 动态加载 + 调用 register(api)
 *
 * 对应 openclaw: src/plugins/loader.ts
 *
 * 职责（与原版一致）：
 *   调用 discoverOpenClawPlugins 获取候选项，
 *   用 jiti 动态 import 入口文件，解析 register/activate，
 *   构造 OpenClawPluginApi 并调用 register(api)，
 *   将 registerChannel 的结果写入 PluginRegistry。
 *
 * plugin-sdk 依赖说明：
 *   全局插件（qqbot/feishu/dingtalk 等）导入 "openclaw/plugin-sdk"，
 *   jiti 需要 alias 将其映射到实际文件。
 *   解析顺序：
 *     1. 环境变量 OPENCLAW_ROOT（推荐在 VSCode launch.json 中设置）
 *     2. 向上遍历目录树查找包含 src/plugin-sdk/root-alias.cjs 的目录
 *
 * 简化说明（相比 openclaw 原版省略的部分）：
 *   - registry 缓存（registryCache）
 *   - normalizePluginsConfig / applyTestPluginDefaults
 *   - PluginRuntime Proxy 懒加载
 *   - loadPluginManifestRegistry（合并 manifest）
 *   - validateJsonSchemaValue（schema 校验）
 *   - openBoundaryFileSync（路径安全）
 *   - initializeGlobalHookRunner
 *   - clearPluginCommands
 *   - plugin-sdk alias 根路径：已实现（resolvePluginSdkAliasForDemo → root-alias.cjs）
 *   - plugin-sdk alias 子路径：已实现（resolvePluginSdkScopedAliasMapForDemo → src/plugin-sdk/xxx.ts）
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { processAgentInput } from "../agent.js";
import {
  transformChannelToAgentInput,
  validateChannelMsgContext,
} from "../transforms/channel-transform.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  ChannelPlugin,
  InboundMessage,
  PluginRuntime,
  ChannelMsgContext,
} from "../types.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { createPluginRegistry, type PluginRegistry } from "./registry.js";

/** 消息处理回调（与 lifecycle.ts 中的 OnMessageCallback 一致） */
export type OnMessageCallback = (msg: InboundMessage) => Promise<void>;

// ─── Pairing allowFrom store（内联实现，函数名和逻辑对齐 pairing-store.ts）──
//
// 对应 openclaw: src/pairing/pairing-store.ts
//
// pairing-store.ts 依赖 file-lock / paths / home-dir 等 openclaw 内部模块，
// 无法在 demo 中直接 import（会拉入庞大的依赖链，且 bun 直接报模块解析错误）。
// 此处用 fs + path + os 复现同名函数的核心逻辑，行为与原版完全一致。
//   readChannelAllowFromStore  ← 对外入口，签名与原版相同
//   resolveCredentialsDir      ← 对应 paths.ts resolveStateDir + resolveOAuthDir
//   safeChannelKey / safeAccountKey ← 文件名安全转义
//   resolveAllowFromPath       ← 拼接带账户 / 遗留两条文件路径
//   dedupePreserveOrder        ← 去重保序
//   normalizeAllowFromList     ← 规范化条目（简化：跳过 adapter，保留 * 过滤逻辑）
//   readAllowFromStateForPath  ← 读取单个文件
//   shouldIncludeLegacyAllowFromEntries / resolveAllowFromAccountId ← 账户判断

const DEFAULT_ACCOUNT_ID = "default"; // 对应 src/routing/account-id.ts

/** 对应 src/config/paths.ts resolveStateDir（含遗留目录检测）+ resolveOAuthDir */
function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const homedir = os.homedir();
  const legacyDirnames = [".clawdbot", ".moldbot", ".moltbot"];
  const newDirname = ".openclaw";

  // resolveOAuthDir: OPENCLAW_OAUTH_DIR 优先
  const oauthOverride = env.OPENCLAW_OAUTH_DIR?.trim();
  if (oauthOverride) {
    return path.resolve(oauthOverride);
  }

  // resolveStateDir: OPENCLAW_STATE_DIR / CLAWDBOT_STATE_DIR 优先
  const stateDirOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateDirOverride) {
    return path.join(path.resolve(stateDirOverride), "credentials");
  }

  // 默认：优先 ~/.openclaw，否则检测遗留目录（与 resolveStateDir 一致）
  const newDir = path.join(homedir, newDirname);
  if (fs.existsSync(newDir)) {
    return path.join(newDir, "credentials");
  }
  const existingLegacy = legacyDirnames
    .map((d) => path.join(homedir, d))
    .find((d) => {
      try {
        return fs.existsSync(d);
      } catch {
        return false;
      }
    });
  return path.join(existingLegacy ?? newDir, "credentials");
}

/** 对应 src/pairing/pairing-store.ts safeChannelKey */
function safeChannelKey(channel: string): string {
  const raw = String(channel).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing channel");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing channel");
  }
  return safe;
}

/** 对应 src/pairing/pairing-store.ts safeAccountKey */
function safeAccountKey(accountId: string): string {
  const raw = String(accountId).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing account id");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing account id");
  }
  return safe;
}

/** 对应 src/pairing/pairing-store.ts resolveAllowFromPath */
function resolveAllowFromPath(
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (!normalizedAccountId) {
    return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(
    resolveCredentialsDir(env),
    `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`,
  );
}

/** 对应 src/pairing/pairing-store.ts dedupePreserveOrder */
function dedupePreserveOrder(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const normalized = String(entry).trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** 对应 src/pairing/pairing-store.ts normalizeAllowFromList（简化：无 adapter） */
function normalizeAllowFromList(store: { allowFrom?: unknown }): string[] {
  const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
  // 原版：normalizeAllowEntry 会将 "*" 映射为 "" 后被 filter(Boolean) 过滤；
  // pairing store 不存储通配符，这里保持相同行为。
  return dedupePreserveOrder(
    list
      .map((v) => {
        const trimmed = String(v).trim();
        return trimmed === "*" ? "" : trimmed;
      })
      .filter(Boolean),
  );
}

/** 对应 src/pairing/pairing-store.ts readAllowFromStateForPath（sync 版本） */
function readAllowFromStateForPath(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeAllowFromList(JSON.parse(raw) as { allowFrom?: unknown });
  } catch {
    return [];
  }
}

/** 对应 src/pairing/pairing-store.ts shouldIncludeLegacyAllowFromEntries */
function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean {
  // 默认账户兼容遗留路径；非默认账户保持隔离，不读遗留文件
  return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}

/** 对应 src/pairing/pairing-store.ts resolveAllowFromAccountId */
function resolveAllowFromAccountId(accountId?: string): string {
  return accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
}

/**
 * 对应 src/pairing/pairing-store.ts readChannelAllowFromStore（同名、同签名）
 *
 * 同时读取带账户后缀路径和遗留路径（仅默认账户），去重后返回。
 * 无文件或解析失败时返回空数组（静默处理）。
 */
function readChannelAllowFromStore(
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);

  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    // 非默认账户：只读带账户后缀路径
    return readAllowFromStateForPath(resolveAllowFromPath(channel, env, resolvedAccountId));
  }

  // 默认账户：读带账户后缀路径 + 遗留路径，去重合并
  // Backward compatibility: legacy channel-level allowFrom store was unscoped.
  const scopedEntries = readAllowFromStateForPath(
    resolveAllowFromPath(channel, env, resolvedAccountId),
  );
  const legacyEntries = readAllowFromStateForPath(resolveAllowFromPath(channel, env));
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

// ─── Pairing upsert store（内联实现，对应 pairing-store.ts + pairing-messages.ts）──
//
// upsertChannelPairingRequest：当 plugin 收到未配对用户消息时调用，
// 将待配对请求写入 ~/.openclaw/credentials/<channel>-pairingRequests.json
// 并返回 { code, created }，供 buildPairingReply 格式化提示语。
//
// 简化点：跳过 withFileLock（demo 单进程无并发竞争风险）

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};

/** 对应 pairing-store.ts resolvePairingPath */
function resolvePairingPath(channel: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-pairingRequests.json`);
}

/** 对应 pairing-store.ts generateUniqueCode */
function generatePairingCode(existingCodes: Set<string>): string {
  const alpha = PAIRING_CODE_ALPHABET;
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
      code += alpha[Math.floor(Math.random() * alpha.length)];
    }
    if (!existingCodes.has(code)) {
      return code;
    }
  }
  throw new Error("pairing: failed to generate unique code");
}

/** 对应 pairing-store.ts readPairingRequests */
function readPairingRequests(filePath: string): PairingRequest[] {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as PairingStore;
    return Array.isArray(parsed.requests) ? parsed.requests : [];
  } catch {
    return [];
  }
}

/** 对应 pairing-store.ts writeJsonFile（简化：直接 writeFileSync） */
function writePairingRequests(filePath: string, requests: PairingRequest[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const data: PairingStore = { version: 1, requests };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

// ─── Media helpers（内联实现，对应 src/media/store.ts + src/media/fetch.ts）──────
//
// saveMediaBuffer：将 plugin 传来的图片/文件 buffer 保存到
//   ~/.openclaw/media/inbound/{uuid}.{ext}
// fetchRemoteMedia：从 URL 下载媒体，返回 { buffer, contentType, fileName }

/** 对应 src/media/store.ts resolveMediaDir（通过 resolveConfigDir 推导） */
function resolveMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.join(path.resolve(override), "media");
  }
  const homedir = os.homedir();
  const newDir = path.join(homedir, ".openclaw");
  const legacyDirs = [".clawdbot", ".moldbot", ".moltbot"].map((d) => path.join(homedir, d));
  const existing = [newDir, ...legacyDirs].find((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
  return path.join(existing ?? newDir, "media");
}

/** 对应 src/media/mime.ts EXT_BY_MIME */
const EXT_BY_MIME: Record<string, string> = {
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

/** 对应 src/media/mime.ts extensionForMime */
function extensionForMime(mime?: string): string | undefined {
  if (!mime) {
    return undefined;
  }
  const normalized = mime.split(";")[0]?.trim().toLowerCase();
  return normalized ? EXT_BY_MIME[normalized] : undefined;
}

/** 对应 src/media/store.ts sanitizeFilename */
function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/** 对应 src/media/store.ts retryAfterRecreatingDir */
async function retryAfterRecreatingDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const isEnoent =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isEnoent) {
      throw err;
    }
    // 目录被清理任务删除时重建后重试
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    return await run();
  }
}

/** 对应 src/media/mime.ts detectMime（使用 file-type 做 buffer 嗅探） */
async function detectMime(
  buffer?: Buffer,
  headerMime?: string | null,
): Promise<string | undefined> {
  const { fileTypeFromBuffer } = await import("file-type");

  const normalizedHeader = headerMime?.split(";")[0]?.trim().toLowerCase() || undefined;

  let sniffed: string | undefined;
  if (buffer && buffer.byteLength > 0) {
    try {
      const result = await fileTypeFromBuffer(buffer);
      sniffed = result?.mime;
    } catch {
      // ignore sniff errors
    }
  }

  // 优先使用 sniffed（更准确），若是 generic 容器类型则降级到 header/ext
  const isGeneric = (m?: string) =>
    !m || m === "application/octet-stream" || m === "application/zip";

  if (sniffed && !isGeneric(sniffed)) {
    return sniffed;
  }
  if (normalizedHeader && !isGeneric(normalizedHeader)) {
    return normalizedHeader;
  }
  if (sniffed) {
    return sniffed;
  }
  return normalizedHeader;
}

/**
 * 简化版 ReplyDispatcher 类型
 *
 * 对应 openclaw: src/auto-reply/reply/reply-dispatcher.ts 的 ReplyDispatcher
 * 飞书等插件通过此接口将 LLM 回复发送回聊天平台
 */
export type DemoReplyDispatcher = {
  sendToolResult: (payload: { text?: string }) => boolean;
  sendBlockReply: (payload: { text?: string }) => boolean;
  sendFinalReply: (payload: { text?: string }) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<string, number>;
  markComplete: () => void;
};

/**
 * 解析 openclaw 根目录（含 src/plugin-sdk/root-alias.cjs 的目录）
 *
 * 解析顺序：
 *   1. 环境变量 OPENCLAW_ROOT — VSCode launch.json 里设置最稳定
 *   2. 向上遍历目录树，找到包含 src/plugin-sdk/root-alias.cjs 的目录
 *      （自动适配任意目录结构，不硬编码层级）
 */
function resolveOpenClawRoot(): string | null {
  // 1. 环境变量优先
  const envRoot = process.env.OPENCLAW_ROOT?.trim();
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    if (fs.existsSync(path.join(resolved, "src", "plugin-sdk", "root-alias.cjs"))) {
      return resolved;
    }
    console.warn(
      `[loader] OPENCLAW_ROOT=${envRoot} set but src/plugin-sdk/root-alias.cjs not found there`,
    );
  }

  // 2. 从当前文件向上遍历查找（最多 8 级，防止到根目录）
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cursor, "src", "plugin-sdk", "root-alias.cjs");
    if (fs.existsSync(candidate)) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    } // 已到根
    cursor = parent;
  }

  return null;
}

/**
 * 解析 openclaw/plugin-sdk 根路径 alias
 * 对应 openclaw loader.ts:112 resolvePluginSdkAlias()
 *
 * 策略：
 *   优先指向 src/plugin-sdk/index.ts（jiti 直接加载 TS 源码，无 ESM interop 问题）
 *   跳过 root-alias.cjs，因为 root-alias.cjs 会优先尝试加载 dist/plugin-sdk/index.js：
 *   该文件是 ESM 格式（import { ... }），jiti 的 CommonJS require 模式无法正确处理
 *   其命名导出，导致 createDefaultChannelRuntimeState 等函数变成 undefined。
 *
 *   root-alias.cjs 作为备用（若 src 不存在，比如生产环境只有 dist）。
 */
function resolvePluginSdkAliasForDemo(): string | null {
  const openclawRoot = resolveOpenClawRoot();
  if (!openclawRoot) {
    return null;
  }
  // 优先 src（jiti 直接转译 TS，无 ESM interop 问题）
  const srcCandidate = path.join(openclawRoot, "src", "plugin-sdk", "index.ts");
  if (fs.existsSync(srcCandidate)) {
    return srcCandidate;
  }
  // 备用：root-alias.cjs（生产环境 dist 存在时）
  const cjsCandidate = path.join(openclawRoot, "src", "plugin-sdk", "root-alias.cjs");
  if (fs.existsSync(cjsCandidate)) {
    return cjsCandidate;
  }
  return null;
}

/**
 * 解析所有 openclaw/plugin-sdk/xxx 子路径 alias
 * 对应 openclaw loader.ts:146 resolvePluginSdkScopedAliasMap()
 *
 * 原版逻辑：
 *   1. 读 package.json exports，找所有 ./plugin-sdk/xxx 条目
 *   2. 每个 subpath 尝试找 src/plugin-sdk/xxx.ts（开发态）或 dist/plugin-sdk/xxx.js（生产态）
 *   3. 写入 alias map："openclaw/plugin-sdk/xxx" → 绝对路径
 *
 * 这样 feishu 等插件的 import { ... } from "openclaw/plugin-sdk/account-id"
 * 就能被 jiti 正确解析。
 */
function resolvePluginSdkScopedAliasMapForDemo(): Record<string, string> {
  const openclawRoot = resolveOpenClawRoot();
  const aliasMap: Record<string, string> = {};
  if (!openclawRoot) {
    return aliasMap;
  }

  // Step 1：读 package.json exports（对应 loader.ts:130 pkgRaw）
  let subpaths: string[] = [];
  try {
    const pkgRaw = fs.readFileSync(path.join(openclawRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as { exports?: Record<string, unknown> };
    subpaths = Object.keys(pkg.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length))
      .filter((subpath) => Boolean(subpath) && !subpath.includes("/"))
      .toSorted();
  } catch {
    return aliasMap;
  }

  // Step 2 & 3：为每个 subpath 找源文件（对应 loader.ts:149-155）
  for (const subpath of subpaths) {
    // 优先 src（开发态），其次 dist（生产态）
    const candidates = [
      path.join(openclawRoot, "src", "plugin-sdk", `${subpath}.ts`),
      path.join(openclawRoot, "dist", "plugin-sdk", `${subpath}.js`),
    ];
    const resolved = candidates.find((c) => fs.existsSync(c));
    if (resolved) {
      aliasMap[`openclaw/plugin-sdk/${subpath}`] = resolved;
    }
  }

  return aliasMap;
}

/**
 * openclaw: PluginLoadOptions (loader.ts:37)
 *
 * 扫描来源对齐原版四级路径：
 *   pluginsDir  → origin "config"    （demo 本地插件目录，传给 extraPaths[0]）
 *   workspaceDir → origin "workspace" （workspaceDir/.openclaw/extensions）
 *   extraPaths  → origin "config"    （任意额外路径）
 *   globalDir   → origin "global"    （~/.openclaw/extensions，自动扫描，无需指定）
 */
export type PluginLoadOptions = {
  /** demo 本地插件目录（可选），作为 config 来源 */
  pluginsDir?: string;
  /** 工作区根目录（可选），扫描 workspaceDir/.openclaw/extensions */
  workspaceDir?: string;
  /** 额外扫描路径（可选，与 openclaw plugins.load.paths 对应） */
  extraPaths?: string[];
  /**
   * 消息处理回调（注入到 api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher）
   *
   * qqbot 等插件不走 ctx.onMessage，而是通过 api.runtime 保存的 pluginRuntime 调用
   * dispatchReplyWithBufferedBlockDispatcher()。
   * 通过此选项把 processMessage 注入进去，使 runtime stub 能真正处理消息。
   */
  onMessage?: OnMessageCallback;
};

/**
 * loadOpenClawPlugins 返回值：注册表 + channelRuntime stub
 *
 * channelRuntime 同时用于：
 *   - api.runtime.channel（qqbot 等通过 pluginRuntime 调用）
 *   - ctx.channelRuntime（新式插件通过 ChannelGatewayContext.channelRuntime 调用）
 */
export type PluginLoadResult = PluginRegistry & {
  /** PluginRuntime["channel"] stub，注入到 ChannelGatewayContext.channelRuntime */
  channelRuntime: PluginRuntime["channel"];
};

// ─── 内部辅助 ──────────────────────────────────────────────────────────────

/**
 * 解析插件模块的导出，提取 register/activate 函数
 * openclaw: resolvePluginModuleExport() (loader.ts:196)
 *
 * 支持：
 *   - 默认导出是函数     → 直接作为 register（loader.ts:207）
 *   - 默认导出是对象     → 取 .register 或 .activate（loader.ts:212）
 *   - 命名导出 register  → 直接使用
 */
function resolvePluginModuleExport(mod: unknown): ((api: OpenClawPluginApi) => void) | null {
  // 处理 ESM default export 包装（loader.ts:200-205）
  const resolved =
    mod && typeof mod === "object" && "default" in (mod as Record<string, unknown>)
      ? (mod as { default: unknown }).default
      : mod;

  if (typeof resolved === "function") {
    return resolved as (api: OpenClawPluginApi) => void;
  }

  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    return def.register ?? def.activate ?? null;
  }

  return null;
}

// ─── 主要导出 ──────────────────────────────────────────────────────────────

/**
 * 加载所有插件，返回填充好的 PluginRegistry 和 channelRuntime stub
 * openclaw: loadOpenClawPlugins() (loader.ts:447)
 *
 * 流程（与原版对齐）：
 *   1. createPluginRegistry()             ← registry.ts:185
 *   2. discoverOpenClawPlugins()          ← discovery.ts:618
 *   3. for each candidate:
 *      a. jiti(source)                   ← loader.ts:663 getJiti()(safeSource)
 *      b. resolvePluginModuleExport(mod)  ← loader.ts:672
 *      c. register(api)                  ← loader.ts:776
 *
 * @param options.pluginsDir  插件目录
 */
export function loadOpenClawPlugins(options: PluginLoadOptions): PluginLoadResult {
  // Step 1：创建注册表（loader.ts:503 createPluginRegistry）
  const registry = createPluginRegistry();

  // ── channel runtime stub ────────────────────────────────────────────────
  // 该对象同时注入到：
  //   1. api.runtime.channel   ← qqbot 等通过 setQQBotRuntime(api.runtime) 获取后调用
  //   2. ctx.channelRuntime    ← 新式插件通过 ChannelGatewayContext.channelRuntime 调用
  //
  // stub 仅覆盖插件实际用到的字段；其余 PluginRuntimeChannel 字段（text、media、
  // pairing、session、mentions 等）用 as unknown as PluginRuntime["channel"] 覆盖。
  const channelRuntime = {
    // ── activity：记录 inbound/outbound 事件（no-op）──────────────────────
    activity: {
      record: (..._args: unknown[]) => {
        // no-op stub，对应 PluginRuntime["channel"]["activity"]["record"]
        // dingtalk 等调用此方法记录活动，demo 不需要记录
      },
      get: (..._args: unknown[]) => undefined,
    },

    // ── routing：解析 agent 路由（返回最小 stub）──────────────────────────
    routing: {
      /**
       * qqbot gateway.ts:632
       * 原版查 cfg 里的 routing 配置，决定把消息发给哪个 agent。
       * demo 直接返回默认路由，使 sessionKey/accountId 正常可用。
       */
      resolveAgentRoute: (opts: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: string; id: string };
      }) => ({
        sessionKey: `${opts.channel}:${opts.accountId}:${opts.peer.id}`,
        accountId: opts.accountId,
        agentId: "default",
      }),
      buildAgentSessionKey: (..._args: unknown[]) => "",
    },

    // ── reply：消息格式化 + 分发（核心）──────────────────────────────────
    reply: {
      /**
       * qqbot gateway.ts:642
       * 返回 envelope 格式选项（时间戳格式、from 格式等）。
       * demo 返回空对象，qqbot 会用默认值。
       */
      resolveEnvelopeFormatOptions: (_cfg: unknown) => ({}),

      /**
       * qqbot gateway.ts:824
       * 把 {from, timestamp, body, ...} 格式化为 Body 字符串。
       * 原版会加 from 前缀、时间戳等；demo 直接返回 body 文本。
       */
      formatInboundEnvelope: (opts: { body?: string; from?: string; [key: string]: unknown }) =>
        opts.body ?? "",

      formatAgentEnvelope: (..._args: unknown[]) => "",

      /**
       * qqbot gateway.ts:985
       * 原版对 ctx 做最终的字段补全/规范化；demo 透传原样返回。
       */
      finalizeInboundContext: (ctx: unknown) => ctx,

      /**
       * qqbot gateway.ts:1063
       * 返回有效的消息配置（responsePrefix 等）。
       * demo 返回最小配置，responsePrefix 为空字符串。
       */
      resolveEffectiveMessagesConfig: (_cfg: unknown, _agentId?: string) => ({
        responsePrefix: "",
      }),

      resolveHumanDelayConfig: (_cfg: unknown) => ({}),

      /**
       * qqbot gateway.ts:1107（核心分发入口）
       * 原版调用 LLM agent，流式推送结果给 deliver 回调。
       * demo：使用 transformChannelToAgentInput 转化 ctx，调用 options.onMessage，
       * 把结果通过 dispatcherOptions.deliver({text}, {kind:"final"}) 发出。
       *
       * 参数对应 qqbot 调用：
       *   ctx = ctxPayload（ChannelMsgContext 类型，Pick<MsgContext> 子集）
       *   cfg = openclaw config
       *   dispatcherOptions.deliver(payload, info) — payload.text 是要发给用户的文本
       */
      dispatchReplyWithBufferedBlockDispatcher: async (params: {
        ctx: ChannelMsgContext; // 使用类型化的 ChannelMsgContext
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string }, info: { kind: string }) => Promise<void>;
          onError?: (err: unknown, info: unknown) => void;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      }) => {
        const { ctx: msgCtx, dispatcherOptions } = params;

        // 验证 ctx 字段（开发模式下辅助调试）
        const validation = validateChannelMsgContext(msgCtx);
        if (!validation.valid) {
          console.warn(`[loader:runtime] invalid ChannelMsgContext:`, validation.missingFields);
        }

        try {
          // 使用 transformChannelToAgentInput 转化为 AgentInput
          // （复刻 openclaw 的 runPreparedReply 逻辑，组装 extraSystemPrompt 等）
          const agentInput = transformChannelToAgentInput(msgCtx);

          console.log(
            `[loader:runtime] dispatchReply from sessionKey "${agentInput.sessionKey}" via channel "${agentInput.messageChannel}"`,
          );

          // 直接调用 processAgentInput（不再经过 onMessage 回调）
          const replyText = await processAgentInput(agentInput);

          await dispatcherOptions.deliver({ text: replyText }, { kind: "final" });
        } catch (err) {
          const errText = `错误：${err instanceof Error ? err.message : String(err)}`;
          dispatcherOptions.onError?.(err, { kind: "agent-dispatch" });
          await dispatcherOptions.deliver({ text: errText }, { kind: "final" });
        }
      },

      /**
       * 路径 C：飞书 / 其他走 openclaw 原版 dispatchReplyFromConfig 链路的插件
       *
       * 飞书调用链：
       *   finalizeInboundContext({...}) → ctxPayload
       *   createReplyDispatcherWithTyping({...}) → { dispatcher, replyOptions, markDispatchIdle }
       *   withReplyDispatcher({ dispatcher, run: () => dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyOptions }) })
       *
       * 对应 openclaw: src/auto-reply/reply/dispatch-from-config.ts:107
       */
      dispatchReplyFromConfig: async (params: {
        ctx: ChannelMsgContext; // FinalizedMsgContext（finalizeInboundContext 的返回值）
        cfg: unknown;
        dispatcher: DemoReplyDispatcher;
        replyOptions?: Record<string, unknown>;
        [key: string]: unknown;
      }) => {
        const { ctx: msgCtx, dispatcher } = params;

        // 验证 ctx 字段
        const validation = validateChannelMsgContext(msgCtx);
        if (!validation.valid) {
          console.warn(
            `[loader:runtime] dispatchReplyFromConfig: invalid ctx:`,
            validation.missingFields,
          );
        }

        try {
          // 转化为 AgentInput（复用路径 B 的转化逻辑）
          const agentInput = transformChannelToAgentInput(msgCtx);

          console.log(
            `[loader:runtime] dispatchReplyFromConfig from sessionKey "${agentInput.sessionKey}" via channel "${agentInput.messageChannel}"`,
          );

          // 调用 agent 处理
          const replyText = await processAgentInput(agentInput);

          // 通过 dispatcher 的 sendFinalReply 发送回复
          // （飞书的 reply-dispatcher 会将 payload.text 发送回飞书聊天）
          dispatcher.sendFinalReply({ text: replyText });

          return {
            queuedFinal: true,
            counts: { final: 1, block: 0, tool: 0 },
          };
        } catch (err) {
          const errText = `错误：${err instanceof Error ? err.message : String(err)}`;
          dispatcher.sendFinalReply({ text: errText });
          return {
            queuedFinal: true,
            counts: { final: 1, block: 0, tool: 0 },
          };
        }
      },

      /**
       * withReplyDispatcher：包装 dispatcher 的执行生命周期
       *
       * 对应 openclaw: src/auto-reply/dispatch.ts:17-33
       * 逻辑：执行 run() → markComplete() → waitForIdle() → onSettled()
       */
      withReplyDispatcher: async <T>(params: {
        dispatcher: DemoReplyDispatcher;
        run: () => Promise<T>;
        onSettled?: () => void | Promise<void>;
      }): Promise<T> => {
        const { dispatcher, run, onSettled } = params;
        try {
          const result = await run();
          return result;
        } finally {
          // 通知 dispatcher 完成
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          // 触发 onSettled 回调（释放资源，如 typing indicator）
          await onSettled?.();
        }
      },

      /**
       * createReplyDispatcherWithTyping：创建带 typing indicator 的回复分发器
       *
       * 对应 openclaw: src/auto-reply/reply/reply-dispatcher.ts
       * 飞书调用此方法创建 { dispatcher, replyOptions, markDispatchIdle }
       *
       * demo 实现：简化版分发器，deliver 回调直接收集文本
       */
      createReplyDispatcherWithTyping: (params: {
        deliver: (payload: { text?: string }, info: { kind: string }) => Promise<void>;
        onReplyStart?: () => void;
        [key: string]: unknown;
      }): {
        dispatcher: DemoReplyDispatcher;
        replyOptions: Record<string, unknown>;
        markDispatchIdle: () => void;
        markRunComplete: () => void;
      } => {
        const { deliver, onReplyStart } = params;
        let _isComplete = false;
        let isIdle = true;
        let idleResolve: (() => void) | null = null;

        const dispatcher: DemoReplyDispatcher = {
          sendToolResult: (payload) => {
            deliver(payload, { kind: "tool" }).catch(() => {});
            return true;
          },
          sendBlockReply: (payload) => {
            deliver(payload, { kind: "block" }).catch(() => {});
            return true;
          },
          sendFinalReply: (payload) => {
            isIdle = false;
            deliver(payload, { kind: "final" })
              .then(() => {
                isIdle = true;
                idleResolve?.();
              })
              .catch(() => {
                isIdle = true;
                idleResolve?.();
              });
            return true;
          },
          waitForIdle: () => {
            if (isIdle) {
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              idleResolve = resolve;
            });
          },
          getQueuedCounts: () => ({ final: 0, block: 0, tool: 0 }),
          markComplete: () => {
            _isComplete = true;
          },
        };

        return {
          dispatcher,
          replyOptions: {
            onReplyStart: onReplyStart ?? (() => {}),
          },
          markDispatchIdle: () => {
            isIdle = true;
            idleResolve?.();
          },
          markRunComplete: () => {
            _isComplete = true;
          },
        };
      },
    },

    // ── 其余命名空间：全 no-op stub ───────────────────────────────────────
    text: {
      chunkByNewline: (text: string) => [text],
      chunkMarkdownText: (text: string) => [text],
      chunkMarkdownTextWithMode: (text: string) => [text],
      chunkText: (text: string) => [text],
      chunkTextWithMode: (text: string) => [text],
      resolveChunkMode: () => "line" as const,
      resolveTextChunkLimit: () => 4096,
      hasControlCommand: () => false,
      resolveMarkdownTableMode: () => "off" as const,
      convertMarkdownTables: (text: string) => text,
    },
    pairing: {
      // 对应 src/pairing/pairing-messages.ts buildPairingReply
      buildPairingReply: ({
        channel,
        idLine,
        code,
      }: {
        channel: string;
        idLine: string;
        code: string;
      }) =>
        [
          "OpenClaw: access not configured.",
          "",
          idLine,
          "",
          `Pairing code: ${code}`,
          "",
          "Ask the bot owner to approve with:",
          `openclaw pairing approve ${channel} ${code}`,
        ].join("\n"),
      readAllowFromStore: ({ channel, accountId, env }) =>
        Promise.resolve(readChannelAllowFromStore(channel, env, accountId)),
      // 对应 src/pairing/pairing-store.ts upsertChannelPairingRequest（简化版，跳过 withFileLock）
      upsertPairingRequest: async ({
        channel,
        id,
        accountId,
        meta,
        env,
      }: {
        channel: string;
        id: string | number;
        accountId: string;
        meta?: Record<string, string | undefined | null>;
        env?: NodeJS.ProcessEnv;
        pairingAdapter?: unknown;
      }): Promise<{ code: string; created: boolean }> => {
        const resolvedEnv = env ?? process.env;
        const filePath = resolvePairingPath(channel, resolvedEnv);
        const normalizedId = String(id).trim();
        const normalizedAccountId = accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
        const now = new Date().toISOString();
        const nowMs = Date.now();

        // 读取现有请求，过滤掉已过期条目
        const allRequests = readPairingRequests(filePath);
        const activeRequests = allRequests.filter((r) => {
          const age = nowMs - new Date(r.lastSeenAt).getTime();
          return age < PAIRING_PENDING_TTL_MS;
        });

        const existingCodes = new Set(activeRequests.map((r) => r.code.trim().toUpperCase()));

        // 查找是否已有同 id + accountId 的记录
        const existingIdx = activeRequests.findIndex(
          (r) =>
            r.id === normalizedId &&
            (r.meta?.accountId ?? DEFAULT_ACCOUNT_ID) === normalizedAccountId,
        );

        const baseMeta: Record<string, string> = { accountId: normalizedAccountId };
        if (meta && typeof meta === "object") {
          for (const [k, v] of Object.entries(meta)) {
            const val = String(v ?? "").trim();
            if (val) {
              baseMeta[k] = val;
            }
          }
        }

        if (existingIdx >= 0) {
          const existing = activeRequests[existingIdx];
          const code = existing.code.trim() || generatePairingCode(existingCodes);
          activeRequests[existingIdx] = { ...existing, code, lastSeenAt: now, meta: baseMeta };
          writePairingRequests(filePath, activeRequests);
          return { code, created: false };
        }

        const code = generatePairingCode(existingCodes);
        const newRequest: PairingRequest = {
          id: normalizedId,
          code,
          createdAt: now,
          lastSeenAt: now,
          meta: baseMeta,
        };
        // 保留最多 3 条（对应 PAIRING_PENDING_MAX）
        const capped = [...activeRequests, newRequest].slice(-3);
        writePairingRequests(filePath, capped);
        return { code, created: true };
      },
    },
    media: {
      // 对应 src/media/fetch.ts fetchRemoteMedia（简化版，无 SSRF 保护）
      fetchRemoteMedia: async (options: {
        url: string;
        requestInit?: RequestInit;
        maxBytes?: number;
        filePathHint?: string;
      }): Promise<{ buffer: Buffer; contentType?: string; fileName?: string } | undefined> => {
        const { url, requestInit, maxBytes } = options;
        try {
          const res = await fetch(url, requestInit);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} fetching media from ${url}`);
          }

          // Content-Length 预检
          const contentLength = res.headers.get("content-length");
          if (maxBytes && contentLength) {
            const len = Number(contentLength);
            if (Number.isFinite(len) && len > maxBytes) {
              throw new Error(`Media from ${url} exceeds maxBytes ${maxBytes}`);
            }
          }

          const arrayBuffer = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          if (maxBytes && buffer.byteLength > maxBytes) {
            throw new Error(`Media from ${url} exceeds maxBytes ${maxBytes}`);
          }

          const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || undefined;

          // 解析 Content-Disposition 提取文件名
          let fileName: string | undefined;
          const disposition = res.headers.get("content-disposition");
          if (disposition) {
            const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
            if (starMatch?.[1]) {
              const encoded =
                starMatch[1].trim().split("''").slice(1).join("''") || starMatch[1].trim();
              try {
                fileName = path.basename(decodeURIComponent(encoded));
              } catch {
                /* ignore */
              }
            } else {
              const match = /filename\s*=\s*([^;]+)/i.exec(disposition);
              if (match?.[1]) {
                fileName = path.basename(match[1].trim().replace(/^["']|["']$/g, ""));
              }
            }
          }
          if (!fileName) {
            try {
              fileName = path.basename(new URL(url).pathname) || undefined;
            } catch {
              /* ignore */
            }
          }

          return { buffer, contentType, fileName };
        } catch (err) {
          console.error(`[media] fetchRemoteMedia failed for ${url}:`, err);
          return undefined;
        }
      },
      // 对应 src/media/store.ts saveMediaBuffer
      saveMediaBuffer: async (
        buffer: Buffer,
        contentType?: string,
        subdir = "inbound",
        maxBytes?: number,
        originalFilename?: string,
      ): Promise<{ id: string; path: string; size: number; contentType?: string }> => {
        const MAX = maxBytes ?? 5 * 1024 * 1024;
        if (buffer.byteLength > MAX) {
          throw new Error(`Media exceeds ${(MAX / (1024 * 1024)).toFixed(0)}MB limit`);
        }

        const dir = path.join(resolveMediaDir(), subdir);
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

        const uuid = crypto.randomUUID();
        const mime = await detectMime(buffer, contentType);
        const headerExt = extensionForMime(contentType?.split(";")[0]?.trim());
        const ext = headerExt ?? extensionForMime(mime) ?? "";

        let id: string;
        if (originalFilename) {
          const base = path.parse(originalFilename).name;
          const sanitized = sanitizeFilename(base);
          id = sanitized ? `${sanitized}---${uuid}${ext}` : `${uuid}${ext}`;
        } else {
          id = ext ? `${uuid}${ext}` : uuid;
        }

        const dest = path.join(dir, id);
        await retryAfterRecreatingDir(dir, () =>
          fs.promises.writeFile(dest, buffer, { mode: 0o644 }),
        );

        return { id, path: dest, size: buffer.byteLength, contentType: mime };
      },
    },
    session: {
      resolveStorePath: (..._args: unknown[]) => "",
      readSessionUpdatedAt: (..._args: unknown[]) => undefined,
      recordSessionMetaFromInbound: (..._args: unknown[]) => {},
      recordInboundSession: (..._args: unknown[]) => {},
      updateLastRoute: (..._args: unknown[]) => {},
    },
    mentions: {
      buildMentionRegexes: (..._args: unknown[]) => [],
      matchesMentionPatterns: (..._args: unknown[]) => false,
      matchesMentionWithExplicit: (..._args: unknown[]) => false,
    },
    reactions: {
      shouldAckReaction: (..._args: unknown[]) => false,
      removeAckReactionAfterReply: (..._args: unknown[]) => {},
    },
    groups: {
      resolveGroupPolicy: (..._args: unknown[]) => "open" as const,
      resolveRequireMention: (..._args: unknown[]) => false,
    },
    debounce: {
      createInboundDebouncer: (..._args: unknown[]) => ({ enqueue: () => {} }),
    },
    commands: {
      isAuthorized: (..._args: unknown[]) => true,
      handleControlCommand: (..._args: unknown[]) => Promise.resolve(false),
    },
  } as unknown as PluginRuntime["channel"];

  // Step 2：探索插件候选项（loader.ts:509 discoverOpenClawPlugins）
  // 四级路径：config(pluginsDir+extraPaths) → workspace → bundled(跳过) → global(自动)
  const { candidates, diagnostics } = discoverOpenClawPlugins({
    pluginsDir: options.pluginsDir,
    workspaceDir: options.workspaceDir,
    extraPaths: options.extraPaths,
  });

  for (const diag of diagnostics) {
    if (diag.level === "error") {
      console.error(`[discovery] ${diag.message}`);
    } else {
      console.debug(`[discovery] ${diag.message}`);
    }
  }

  const sourceDesc = [
    options.pluginsDir && `pluginsDir(${options.pluginsDir})`,
    options.workspaceDir && `workspace(${options.workspaceDir})`,
    "global(~/.openclaw/extensions)",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`[loader] found ${candidates.length} plugin candidate(s) from: ${sourceDesc}`);

  // jiti 实例（loader.ts:538 createJiti）
  // 配置 openclaw/plugin-sdk alias，使全局插件（~/.openclaw/extensions/）能正常加载
  // 根路径 alias（openclaw/plugin-sdk → root-alias.cjs）
  const pluginSdkAlias = resolvePluginSdkAliasForDemo();
  // 子路径 alias（openclaw/plugin-sdk/xxx → src/plugin-sdk/xxx.ts）
  // 对应 openclaw loader.ts:543-546
  const jitiAlias: Record<string, string> = {
    ...(pluginSdkAlias ? { "openclaw/plugin-sdk": pluginSdkAlias } : {}),
    // clawdbot/plugin-sdk 是旧品牌名（dingtalk-connector 等旧插件使用），映射到同一目标
    ...(pluginSdkAlias ? { "clawdbot/plugin-sdk": pluginSdkAlias } : {}),
    ...resolvePluginSdkScopedAliasMapForDemo(),
  };
  if (pluginSdkAlias) {
    const subpathCount = Object.keys(jitiAlias).length - 1;
    console.debug(`[loader] plugin-sdk alias → root + ${subpathCount} subpath(s)`);
  } else {
    console.warn(
      `[loader] plugin-sdk alias not found; plugins importing openclaw/plugin-sdk may fail`,
    );
  }

  // jiti 实例（loader.ts:538 createJiti）
  // jiti 内部为每个子模块创建独立的 jiti 实例，并通过 Module._nodeModulePaths()
  // 自动设置正确的搜索路径，因此跨目录插件（如 ~/.openclaw/extensions/feishu）
  // 的 npm 依赖（如 @larksuiteoapi/node-sdk）无需额外配置即可正确解析。
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs"],
    alias: jitiAlias,
    // 对插件依赖中的 pre-bundled CJS 包（如 dingtalk-stream 内置的 follow-redirects）
    // 使用原生 require 加载，跳过 Babel transform。
    // 背景：follow-redirects 的 createErrorType 调用 Error.captureStackTrace(this, ...)，
    // jiti 的 Babel transform 会破坏 this 上下文导致 "First argument must be an Error object"。
    // nativeModules 列出的包名由 jiti 直接 require，不经过 Babel 转译管道。
    nativeModules: ["follow-redirects", "axios", "dingtalk-stream"],
  });

  // Step 3：逐个加载（对应 loader.ts 中对每个 candidate 的处理循环）
  for (const candidate of candidates) {
    const { idHint, source, manifest } = candidate;

    console.log(`[loader] loading plugin "${idHint}" from ${source}`);

    // a. jiti 动态 import（loader.ts:663 getJiti()(safeSource)）
    let mod: unknown;
    try {
      mod = jiti(source);
    } catch (err) {
      console.error(`[loader] failed to import plugin "${idHint}":`, err);
      continue;
    }

    // b. 解析 register/activate（loader.ts:672 resolvePluginModuleExport）
    const register = resolvePluginModuleExport(mod);
    if (!register) {
      console.warn(`[loader] plugin "${idHint}" has no register/activate export, skipping`);
      continue;
    }

    // c. 构造 OpenClawPluginApi 并调用 register(api)（loader.ts:769 createApi + register(api)）
    const api: OpenClawPluginApi = {
      // ── 元数据（loader.ts:769）
      id: idHint,
      name: manifest?.name ?? idHint,
      source,

      // ── 配置（OpenClawConfig 全字段可选，{} 完全合法）
      config: {},
      pluginConfig: undefined,

      // ── 运行时（类型对齐 PluginRuntime）
      // 注：stub 仅覆盖插件实际用到的字段；类型断言绕过未实现的字段
      runtime: {
        // PluginRuntimeCore 必填字段
        version: "demo",
        config: {
          loadConfig: async () => ({}),
          writeConfigFile: async (_cfg: unknown) => {
            // no-op stub
          },
        },

        // subagent stub（PluginRuntime 必填，插件一般不调用）
        subagent: {
          run: async (_params: unknown) => ({ runId: "" }),
          waitForRun: async (_params: unknown) => ({ status: "ok" as const }),
          getSessionMessages: async (_params: unknown) => ({ messages: [] }),
          getSession: async (_params: unknown) => ({ messages: [] }),
          deleteSession: async (_params: unknown) => {},
        },

        // channel：使用共享的 channelRuntime stub
        channel: channelRuntime,
      } as unknown as PluginRuntime,

      // ── 日志（完整实现）
      // 官方 PluginLogger 签名为 (message: string) => void
      logger: {
        debug: (message: string) => console.debug(`[plugin:${idHint}]`, message),
        info: (message: string) => console.log(`[plugin:${idHint}]`, message),
        warn: (message: string) => console.warn(`[plugin:${idHint}]`, message),
        error: (message: string) => console.error(`[plugin:${idHint}]`, message),
      },

      // ── 核心：registerChannel（完整实现）
      // 原版支持 { plugin: ChannelPlugin } 或直接传 ChannelPlugin 两种形式
      // (src/plugins/types.ts:283)
      registerChannel: (registration: { plugin: ChannelPlugin } | ChannelPlugin) => {
        const plugin =
          registration && typeof registration === "object" && "plugin" in registration
            ? (registration as { plugin: ChannelPlugin }).plugin
            : registration;
        registry.registerChannel(idHint, plugin, source);
      },

      // ── 以下均为 stub：调用不报错，功能被丢弃 ─────────────────────────

      // AI agent 工具（src/plugins/types.ts:273）
      registerTool: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerTool (stub)`);
      },

      // 生命周期钩子 - 旧版接口（src/plugins/types.ts:277）
      registerHook: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerHook (stub)`);
      },

      // HTTP 路由（src/plugins/types.ts:282）
      registerHttpRoute: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerHttpRoute (stub)`);
      },

      // 网关 RPC 方法（src/plugins/types.ts:284）
      // dingtalk 用此注册 dingtalk-connector.status 等远程调用入口
      // 类型断言绕过 GatewayRequestHandler 的严格签名（demo 不需要 opts 参数）
      registerGatewayMethod: ((method: string, _handler: unknown) => {
        console.debug(
          `[loader] plugin "${idHint}" called registerGatewayMethod("${method}") (stub)`,
        );
      }) as OpenClawPluginApi["registerGatewayMethod"],

      // CLI 子命令（src/plugins/types.ts:285）
      registerCli: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerCli (stub)`);
      },

      // 后台服务（src/plugins/types.ts:286）
      registerService: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerService (stub)`);
      },

      // AI 模型 provider（src/plugins/types.ts:287）
      registerProvider: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerProvider (stub)`);
      },

      // 自定义命令，绕过 LLM（src/plugins/types.ts:293）
      registerCommand: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerCommand (stub)`);
      },

      // 上下文引擎（src/plugins/types.ts:295）
      registerContextEngine: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called registerContextEngine (stub)`);
      },

      // 路径解析（src/plugins/types.ts:299）—— 返回原路径
      resolvePath: (input: string) => input,

      // 类型安全生命周期钩子 - 新版接口（src/plugins/types.ts:301）
      on: (..._args: unknown[]) => {
        console.debug(`[loader] plugin "${idHint}" called on() (stub)`);
      },
    };

    try {
      register(api);
      console.log(`[loader] plugin "${idHint}" register() completed`);
    } catch (err) {
      console.error(`[loader] plugin "${idHint}" register() threw:`, err);
    }
  }

  return { ...registry, channelRuntime };
}
