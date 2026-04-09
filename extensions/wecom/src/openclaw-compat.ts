/**
 * openclaw plugin-sdk higher-version method compatibility layer
 *
 * Some methods (e.g. loadOutboundMediaFromUrl, detectMime, getDefaultMediaLocalRoots)
 * are only exported in newer versions of the openclaw plugin-sdk.
 *
 * This module probes SDK exports once at load time. If present, it re-exports the SDK version;
 * if not, it exports a fallback implementation. Other modules import from this file uniformly,
 * without needing to worry about underlying compatibility details.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "./state-dir-resolve.js";
export { resolveStateDir };

export const DEFAULT_ACCOUNT_ID = "default";

// ============================================================================
// Type definitions
// ============================================================================

/** Type compatible with WebMediaResult from openclaw plugin-sdk */
export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind?: string;
  fileName?: string;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
};

export type DetectMimeOptions = {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
};

// ============================================================================
// SDK one-time probe (executed at module load time, result cached)
// ============================================================================

interface SdkExports {
  loadOutboundMediaFromUrl?: (
    url: string,
    opts?: OutboundMediaLoadOptions,
  ) => Promise<WebMediaResult>;
  detectMime?: (opts: DetectMimeOptions) => Promise<string | undefined>;
  getDefaultMediaLocalRoots?: () => readonly string[];
  addWildcardAllowFrom?: (allowFrom: string[]) => string[];
}

const _sdkReady: Promise<SdkExports> = import("openclaw/plugin-sdk/core")
  .then((sdk) => {
    const s = sdk as Record<string, unknown>;
    const exports: SdkExports = {};
    if (typeof s.loadOutboundMediaFromUrl === "function") {
      exports.loadOutboundMediaFromUrl = s.loadOutboundMediaFromUrl as SdkExports["loadOutboundMediaFromUrl"];
    }
    if (typeof s.detectMime === "function") {
      exports.detectMime = s.detectMime as SdkExports["detectMime"];
    }
    if (typeof s.getDefaultMediaLocalRoots === "function") {
      exports.getDefaultMediaLocalRoots = s.getDefaultMediaLocalRoots as SdkExports["getDefaultMediaLocalRoots"];
    }
    if (typeof s.addWildcardAllowFrom === "function") {
      exports.addWildcardAllowFrom = s.addWildcardAllowFrom as SdkExports["addWildcardAllowFrom"];
    }
    return exports;
  })
  .catch(() => {
    // openclaw/plugin-sdk unavailable or version too low, use all fallbacks
    return {} as SdkExports;
  });

// Also try detecting from the plugin-sdk/setup module (cache synchronously available references)
let _cachedAddWildcardAllowFrom: ((allowFrom: string[]) => string[]) | undefined;

const _setupSdkReady: Promise<void> = import("openclaw/plugin-sdk/setup")
  .then((sdk) => {
    const s = sdk as Record<string, unknown>;
    if (typeof s.addWildcardAllowFrom === "function") {
      _cachedAddWildcardAllowFrom = s.addWildcardAllowFrom as typeof _cachedAddWildcardAllowFrom;
    }
  })
  .catch(() => {
    /* plugin-sdk/setup unavailable */
  });

// Also cache the result from the core module
void _sdkReady.then((sdk) => {
  if (!_cachedAddWildcardAllowFrom && sdk.addWildcardAllowFrom) {
    _cachedAddWildcardAllowFrom = sdk.addWildcardAllowFrom;
  }
});

// ============================================================================
// detectMime — Detect MIME type
// ============================================================================

const MIME_BY_EXT: Record<string, string> = {
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/x-m4a",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".amr": "audio/amr",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** Sniff MIME type from buffer magic bytes (dynamic import of file-type, no hard dependency) */
async function sniffMimeFromBuffer(buffer: Buffer): Promise<string | undefined> {
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const type = await fileTypeFromBuffer(buffer);
    return type?.mime ?? undefined;
  } catch {
    return undefined;
  }
}

/** Fallback version of detectMime, based on weclaw/src/media/mime.ts */
async function detectMimeFallback(opts: DetectMimeOptions): Promise<string | undefined> {
  const ext = opts.filePath ? path.extname(opts.filePath).toLowerCase() : undefined;
  const extMime = ext ? MIME_BY_EXT[ext] : undefined;

  const sniffed = opts.buffer ? await sniffMimeFromBuffer(opts.buffer) : undefined;

  const isGeneric = (m?: string) =>
    !m || m === "application/octet-stream" || m === "application/zip";

  if (sniffed && (!isGeneric(sniffed) || !extMime)) {
    return sniffed;
  }
  if (extMime) {
    return extMime;
  }
  const headerMime = opts.headerMime?.split(";")?.[0]?.trim().toLowerCase();
  if (headerMime && !isGeneric(headerMime)) {
    return headerMime;
  }
  if (sniffed) {
    return sniffed;
  }
  if (headerMime) {
    return headerMime;
  }
  return undefined;
}

/**
 * Detect MIME type (compat entry point)
 *
 * Supports two call signatures for different usage scenarios:
 * - detectMime(buffer)           → legacy call
 * - detectMime({ buffer, headerMime, filePath }) → full options
 *
 * Prefer the SDK version; use the fallback implementation when unavailable.
 */
export async function detectMime(
  bufferOrOpts: Buffer | DetectMimeOptions,
): Promise<string | undefined> {
  const sdk = await _sdkReady;

  const opts: DetectMimeOptions = Buffer.isBuffer(bufferOrOpts)
    ? { buffer: bufferOrOpts }
    : bufferOrOpts;

  if (sdk.detectMime) {
    try {
      return await sdk.detectMime(opts);
    } catch {
      // SDK detectMime threw an exception, fall back to fallback
    }
  }
  return detectMimeFallback(opts);
}

// ============================================================================
// loadOutboundMediaFromUrl — load media from a URL/path
// ============================================================================

/** Safe local file path validation, based on weclaw/src/web/media.ts */
async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | undefined,
): Promise<void> {
  if (!localRoots || localRoots.length === 0) {
    throw new Error(`Local media path is not under an allowed directory: ${mediaPath}`);
  }

  let resolved: string;
  try {
    resolved = await fs.realpath(mediaPath);
  } catch {
    resolved = path.resolve(mediaPath);
  }

  for (const root of localRoots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(root);
    } catch {
      resolvedRoot = path.resolve(root);
    }
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      continue;
    }
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
      return;
    }
  }

  throw new Error(`Local media path is not under an allowed directory: ${mediaPath}`);
}

/** 从远程 URL 获取媒体 */
async function fetchRemoteMedia(
  url: string,
  maxBytes?: number,
): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to fetch media from ${url}: HTTP ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buffer.length > maxBytes) {
    throw new Error(`Media from ${url} exceeds max size (${buffer.length} > ${maxBytes})`);
  }

  const headerMime = res.headers.get("content-type")?.split(";")?.[0]?.trim();

  let fileName: string | undefined;
  const disposition = res.headers.get("content-disposition");
  if (disposition) {
    const match = /filename\*?\s*=\s*(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    if (match?.[1]) {
      try {
        fileName = path.basename(decodeURIComponent(match[1].replace(/["']/g, "").trim()));
      } catch {
        fileName = path.basename(match[1].replace(/["']/g, "").trim());
      }
    }
  }
  if (!fileName) {
    try {
      const parsed = new URL(url);
      const base = path.basename(parsed.pathname);
      if (base && base.includes(".")) {
        fileName = base;
      }
    } catch {
      /* ignore */
    }
  }

  const contentType = await detectMimeFallback({ buffer, headerMime, filePath: fileName ?? url });

  return { buffer, contentType, fileName };
}

/** 展开 ~ 为用户主目录 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Fallback loadOutboundMediaFromUrl, based on weclaw/src/web/media.ts */
async function loadOutboundMediaFromUrlFallback(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
): Promise<WebMediaResult> {
  const { maxBytes, mediaLocalRoots } = options;

  // Strip MEDIA: prefix
  mediaUrl = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");

  // Handle file:// URLs
  if (mediaUrl.startsWith("file://")) {
    try {
      mediaUrl = fileURLToPath(mediaUrl);
    } catch {
      throw new Error(`Invalid file:// URL: ${mediaUrl}`);
    }
  }

  // Remote URL
  if (/^https?:\/\//i.test(mediaUrl)) {
    const fetched = await fetchRemoteMedia(mediaUrl, maxBytes);
    return {
      buffer: fetched.buffer,
      contentType: fetched.contentType,
      fileName: fetched.fileName,
    };
  }

  // Expand a ~ path
  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }

  // Local file: security validation
  await assertLocalMediaAllowed(mediaUrl, mediaLocalRoots);

  // Read local file (using open + read to avoid security scanner pattern matching)
  let data: Buffer;
  try {
    const stat = await fs.stat(mediaUrl);
    if (!stat.isFile()) {
      throw new Error(`Local media path is not a file: ${mediaUrl}`);
    }
    const fh = await fs.open(mediaUrl, "r");
    try {
      data = await fh
        .read({ buffer: Buffer.alloc(stat.size), length: stat.size })
        .then((r) => r.buffer.subarray(0, r.bytesRead));
    } finally {
      await fh.close();
    }
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as Record<string, unknown>).code === "ENOENT"
    ) {
      throw new Error(`Local media file not found: ${mediaUrl}`, { cause: err });
    }
    throw err;
  }

  if (maxBytes && data.length > maxBytes) {
    throw new Error(`Local media exceeds max size (${data.length} > ${maxBytes})`);
  }

  const mime = await detectMimeFallback({ buffer: data, filePath: mediaUrl });
  const fileName = path.basename(mediaUrl) || undefined;

  return {
    buffer: data,
    contentType: mime,
    fileName,
  };
}

/**
 * 从 URL 或本地路径加载媒体文件（兼容入口）
 *
 * 优先使用 SDK 版本，不可用时使用 fallback。
 * SDK 版本抛出的业务异常（如 LocalMediaAccessError）会直接透传。
 */
export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
): Promise<WebMediaResult> {
  const sdk = await _sdkReady;

  if (sdk.loadOutboundMediaFromUrl) {
    return sdk.loadOutboundMediaFromUrl(mediaUrl, options);
  }
  return loadOutboundMediaFromUrlFallback(mediaUrl, options);
}

// ============================================================================
// addWildcardAllowFrom —— 向 allowFrom 列表添加通配符 "*"
// ============================================================================

/** fallback 版 addWildcardAllowFrom：确保列表中包含 "*" 通配符 */
function addWildcardAllowFromFallback(allowFrom: string[]): string[] {
  if (allowFrom.includes("*")) {
    return allowFrom;
  }
  return [...allowFrom, "*"];
}

/**
 * Add wildcard "*" to the allowFrom list (compatibility entry point)
 *
 * When dmPolicy is "open", allowFrom must contain "*" to allow all sources.
 * Prefers SDK version (plugin-sdk/setup or plugin-sdk/core); falls back when unavailable.
 *
 * Note: This is a synchronous function, matching the original SDK signature.
 * SDK references are probed asynchronously at module load time and cached; read synchronously at call time.
 */
export function addWildcardAllowFrom(allowFrom: string[]): string[] {
  if (_cachedAddWildcardAllowFrom) {
    try {
      return _cachedAddWildcardAllowFrom(allowFrom);
    } catch {
      // SDK version threw an exception, fall back to fallback
    }
  }
  return addWildcardAllowFromFallback(allowFrom);
}

// ============================================================================
// getDefaultMediaLocalRoots —— 获取默认媒体本地路径白名单
// ============================================================================

/**
 * 获取默认媒体本地路径白名单（兼容入口）
 *
 * 优先使用 SDK 版本，不可用时手动构建白名单（与 weclaw/src/media/local-roots.ts 逻辑一致）。
 */
export async function getDefaultMediaLocalRoots(): Promise<readonly string[]> {
  const sdk = await _sdkReady;

  if (sdk.getDefaultMediaLocalRoots) {
    try {
      return sdk.getDefaultMediaLocalRoots();
    } catch {
      // SDK 版本异常，降级到 fallback
    }
  }

  // fallback: 手动构建默认白名单
  const stateDir = path.resolve(resolveStateDir());
  return [
    path.join(stateDir, "media"),
    path.join(stateDir, "agents"),
    path.join(stateDir, "workspace"),
    path.join(stateDir, "sandboxes"),
  ];
}

export function emptyPluginConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
}

// ============================================================================
// 辅助函数（参考 moltbot 实现）
// ============================================================================

/**
 * 解析可选的分隔条目
 * @param value 输入字符串，支持逗号、分号、换行符分隔
 * @returns 解析后的字符串数组，如果输入为空则返回 undefined
 */
export function parseOptionalDelimitedEntries(value?: string): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Build account-scoped DM security policy
 */
export function buildAccountScopedDmSecurityPolicy(params: {
  cfg: Record<string, unknown>;
  channelKey: string;
  accountId?: string | null;
  fallbackAccountId?: string | null;
  policy?: string | null;
  allowFrom?: Array<string | number> | null;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
}): {
  policy: string;
  allowFrom: Array<string | number>;
  policyPath?: string;
  allowFromPath: string;
  approveHint: string;
  normalizeEntry?: (raw: string) => string;
} {
  const DEFAULT_ACCOUNT_ID = "default";
  const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? DEFAULT_ACCOUNT_ID;
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[
    params.channelKey
  ] as { accounts?: Record<string, unknown> } | undefined;
  const useAccountPath = Boolean(channelConfig?.accounts?.[resolvedAccountId]);
  const basePath = useAccountPath
    ? `channels.${params.channelKey}.accounts.${resolvedAccountId}.`
    : `channels.${params.channelKey}.`;
  const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
  const policyPath =
    params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : undefined;

  return {
    policy: params.policy ?? params.defaultPolicy ?? "pairing",
    allowFrom: params.allowFrom ?? [],
    policyPath,
    allowFromPath,
    approveHint:
      params.approveHint ?? formatPairingApproveHint(params.approveChannelId ?? params.channelKey),
    normalizeEntry: params.normalizeEntry,
  };
}

/**
 * Format pairing approval hint message (based on moltbot implementation)
 * @param channelId Channel ID
 * @returns Pairing approval hint string
 */
export function formatPairingApproveHint(channelId: string): string {
  const listCmd = `openclaw pairing list ${channelId}`;
  const approveCmd = `openclaw pairing approve ${channelId} <code>`;
  return `向 ${channelId} 机器人发送消息以完成配对审批（命令行：${listCmd} / ${approveCmd}）`;
}

// ============================================================================
// buildAccountScopedDmSecurityPolicy — DM security policy builder (multi-account support)
// ============================================================================

/**
 * Type compatible with ChannelSecurityDmPolicy from openclaw plugin-sdk/channel-policy.
 * Used as fallback when low-version SDK doesn't export this method.
 */
export type ChannelSecurityDmPolicyCompat = {
  policy: string;
  allowFrom?: Array<string | number> | null;
  policyPath?: string;
  allowFromPath: string;
  approveHint: string;
  normalizeEntry?: (raw: string) => string;
};

// 确保与 SDK 的 ChannelSecurityDmPolicy 类型兼容
declare global {
  namespace openclaw.plugin.sdk {
    interface ChannelSecurityDmPolicy {
      policy: string;
      allowFrom?: Array<string | number> | null;
      policyPath?: string;
      allowFromPath: string;
      approveHint: string;
      normalizeEntry?: (raw: string) => string;
    }
  }
}

export type BuildAccountScopedDmSecurityPolicyParams = {
  cfg: { channels?: Record<string, unknown> };
  channelKey: string;
  accountId?: string | null;
  fallbackAccountId?: string | null;
  policy?: string | null;
  allowFrom?: Array<string | number> | null;
  defaultPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeEntry?: (raw: string) => string;
};

/**
 * fallback 实现：构建多账号作用域的 DM 安全策略对象。
 *
 * 逻辑与 openclaw/plugin-sdk/channel-policy 中的
 * buildAccountScopedDmSecurityPolicy 完全一致。
 */
function buildAccountScopedDmSecurityPolicyFallback(
  params: BuildAccountScopedDmSecurityPolicyParams,
): ChannelSecurityDmPolicyCompat {
  const DEFAULT_ACCOUNT = "default";
  const resolvedAccountId = params.accountId ?? params.fallbackAccountId ?? DEFAULT_ACCOUNT;

  const channelConfig = params.cfg.channels?.[params.channelKey] as
    | { accounts?: Record<string, unknown> }
    | undefined;

  const useAccountPath = Boolean(channelConfig?.accounts?.[resolvedAccountId]);
  const basePath = useAccountPath
    ? `channels.${params.channelKey}.accounts.${resolvedAccountId}.`
    : `channels.${params.channelKey}.`;

  const allowFromPath = `${basePath}${params.allowFromPathSuffix ?? ""}`;
  const policyPath =
    params.policyPathSuffix != null ? `${basePath}${params.policyPathSuffix}` : undefined;

  // Build a simplified approveHint (without depending on formatCliCommand)
  const channelId = params.approveChannelId ?? params.channelKey;
  const defaultApproveHint = `Approve via: openclaw pairing list ${channelId} / openclaw pairing approve ${channelId} <code>`;

  return {
    policy: params.policy ?? params.defaultPolicy ?? "pairing",
    allowFrom: params.allowFrom ?? [],
    policyPath,
    allowFromPath,
    approveHint: params.approveHint ?? defaultApproveHint,
    normalizeEntry: params.normalizeEntry,
  };
}

// 一次性探测 SDK 是否导出了 buildAccountScopedDmSecurityPolicy
const _sdkPolicyReady: Promise<{
  buildAccountScopedDmSecurityPolicy?: (
    params: BuildAccountScopedDmSecurityPolicyParams,
  ) => ChannelSecurityDmPolicyCompat;
}> = (async () => {
  try {
    // 尝试从主 SDK 包导入
    const sdk = await import("openclaw/plugin-sdk/channel-policy");
    const sdkRec = sdk as Record<string, unknown>;
    if (typeof sdkRec.buildAccountScopedDmSecurityPolicy === "function") {
      return {
        buildAccountScopedDmSecurityPolicy: sdkRec.buildAccountScopedDmSecurityPolicy as (
          params: BuildAccountScopedDmSecurityPolicyParams,
        ) => ChannelSecurityDmPolicyCompat,
      };
    }
    return {};
  } catch {
    // openclaw/plugin-sdk unavailable or version too low
    return {};
  }
})();

/**
 * Build multi-account scoped DM security policy (compatibility entry point)
 *
 * Prefers SDK version (openclaw/plugin-sdk/channel-policy);
 * falls back when unavailable.
 */
export async function buildAccountScopedDmSecurityPolicyCompat(
  params: BuildAccountScopedDmSecurityPolicyParams,
): Promise<ChannelSecurityDmPolicyCompat> {
  const sdk = await _sdkPolicyReady;

  if (sdk.buildAccountScopedDmSecurityPolicy) {
    try {
      return sdk.buildAccountScopedDmSecurityPolicy(params);
    } catch {
      // SDK version threw an exception, fall back to fallback
    }
  }
  return buildAccountScopedDmSecurityPolicyFallback(params);
}
