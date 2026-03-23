/**
 * 版本检查器
 *
 * - triggerUpdateCheck(): gateway 启动时调用，后台预热缓存
 * - getUpdateInfo(): 每次实时查询 npm registry，返回最新结果
 *
 * 使用 HTTPS 直接请求 npm registry API（不依赖 npm CLI），
 * 支持多 registry fallback：npmjs.org → npmmirror.com，解决国内网络问题。
 */

import https from "node:https";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PKG_NAME = "@tencent-connect/openclaw-qqbot";
const ENCODED_PKG = encodeURIComponent(PKG_NAME);

const REGISTRIES = [
  `https://registry.npmjs.org/${ENCODED_PKG}`,
  `https://registry.npmmirror.com/${ENCODED_PKG}`,
];

let CURRENT_VERSION = "unknown";
try {
  const pkg = require("../package.json");
  CURRENT_VERSION = pkg.version ?? "unknown";
} catch {
  // fallback
}

export interface UpdateInfo {
  current: string;
  /** 最佳升级目标（prerelease 用户优先 alpha，稳定版用户取 latest） */
  latest: string | null;
  /** 稳定版 dist-tag */
  stable: string | null;
  /** alpha dist-tag */
  alpha: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

let _log:
  | { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void }
  | undefined;

function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: timeoutMs, headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`timeout fetching ${url}`));
    });
  });
}

async function fetchDistTags(): Promise<Record<string, string>> {
  for (const url of REGISTRIES) {
    try {
      const json = await fetchJson(url, 10_000);
      const tags = json["dist-tags"];
      if (tags && typeof tags === "object") return tags;
    } catch (e: any) {
      _log?.debug?.(`[qqbot:update-checker] ${url} failed: ${e.message}`);
    }
  }
  throw new Error("all registries failed");
}

function buildUpdateInfo(tags: Record<string, string>): UpdateInfo {
  const currentIsPrerelease = CURRENT_VERSION.includes("-");
  const stableTag = tags.latest || null;
  const alphaTag = tags.alpha || null;

  // 严格隔离：alpha 只跟 alpha 比，正式版只跟正式版比，不交叉
  const compareTarget = currentIsPrerelease ? alphaTag : stableTag;

  const hasUpdate =
    typeof compareTarget === "string" &&
    compareTarget !== CURRENT_VERSION &&
    compareVersions(compareTarget, CURRENT_VERSION) > 0;

  return {
    current: CURRENT_VERSION,
    latest: compareTarget,
    stable: stableTag,
    alpha: alphaTag,
    hasUpdate,
    checkedAt: Date.now(),
  };
}

/** gateway 启动时调用，保存 log 引用 */
export function triggerUpdateCheck(log?: {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}): void {
  if (log) _log = log;
  // 预热：fire-and-forget
  getUpdateInfo()
    .then((info) => {
      if (info.hasUpdate) {
        _log?.info?.(
          `[qqbot:update-checker] new version available: ${info.latest} (current: ${CURRENT_VERSION})`,
        );
      }
    })
    .catch(() => {});
}

/** 每次实时查询 npm registry */
export async function getUpdateInfo(): Promise<UpdateInfo> {
  try {
    const tags = await fetchDistTags();
    return buildUpdateInfo(tags);
  } catch (err: any) {
    _log?.debug?.(`[qqbot:update-checker] check failed: ${err.message}`);
    return {
      current: CURRENT_VERSION,
      latest: null,
      stable: null,
      alpha: null,
      hasUpdate: false,
      checkedAt: Date.now(),
      error: err.message,
    };
  }
}

/**
 * 检查指定版本是否存在于 npm registry
 * 用于 /bot-upgrade --version 的前置校验
 */
export async function checkVersionExists(version: string): Promise<boolean> {
  for (const baseUrl of REGISTRIES) {
    try {
      const url = `${baseUrl}/${version}`;
      const json = await fetchJson(url, 10_000);
      if (json && json.version === version) return true;
    } catch {
      // try next registry
    }
  }
  return false;
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.replace(/^v/, "");
    const [main, pre] = clean.split("-", 2);
    return { parts: main.split(".").map(Number), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  // 先比主版本号
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  // 主版本号相同：正式版 > prerelease
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  // 都是 prerelease：按段逐一比较（alpha.1 vs alpha.2）
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    // 都是数字则按数字比较
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      // 字符串比较
      if (aP < bP) return -1;
      if (aP > bP) return 1;
    }
  }
  return 0;
}
