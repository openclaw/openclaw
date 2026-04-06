/**
 * Update-check helpers for the standalone npm package.
 *
 * `triggerUpdateCheck()` warms the cache in the background and `getUpdateInfo()`
 * queries the registry on demand. The lookup talks directly to the npm registry
 * API and falls back from npmjs.org to npmmirror.com.
 */

import https from "node:https";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const PKG_NAME = "@openclaw/qqbot";
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
  /** Preferred upgrade target: alpha for prerelease users, latest for stable users. */
  latest: string | null;
  /** Stable dist-tag. */
  stable: string | null;
  /** Alpha dist-tag. */
  alpha: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

let _log:
  | { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void }
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
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
      const tags = isRecord(json) ? json["dist-tags"] : undefined;
      if (isRecord(tags)) {
        return Object.fromEntries(
          Object.entries(tags).filter((entry): entry is [string, string] => {
            return typeof entry[1] === "string";
          }),
        );
      }
    } catch (e: unknown) {
      _log?.debug?.(
        `[qqbot:update-checker] ${url} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  throw new Error("all registries failed");
}

function buildUpdateInfo(tags: Record<string, string>): UpdateInfo {
  const currentIsPrerelease = CURRENT_VERSION.includes("-");
  const stableTag = tags.latest || null;
  const alphaTag = tags.alpha || null;

  // Keep prerelease and stable tracks isolated from each other.
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

/** Capture a logger and warm the update check in the background. */
export function triggerUpdateCheck(log?: {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}): void {
  if (log) {
    _log = log;
  }
  // Warm the cache without blocking startup.
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

/** Query the npm registry on demand. */
export async function getUpdateInfo(): Promise<UpdateInfo> {
  try {
    const tags = await fetchDistTags();
    return buildUpdateInfo(tags);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    _log?.debug?.(`[qqbot:update-checker] check failed: ${message}`);
    return {
      current: CURRENT_VERSION,
      latest: null,
      stable: null,
      alpha: null,
      hasUpdate: false,
      checkedAt: Date.now(),
      error: message,
    };
  }
}

/**
 * Check whether a specific version exists in the npm registry.
 */
export async function checkVersionExists(version: string): Promise<boolean> {
  for (const baseUrl of REGISTRIES) {
    try {
      const url = `${baseUrl}/${version}`;
      const json = await fetchJson(url, 10_000);
      if (isRecord(json) && json.version === version) {
        return true;
      }
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
  // Compare the numeric core version first.
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  // For equal core versions, stable beats prerelease.
  if (!pa.pre && pb.pre) {
    return 1;
  }
  if (pa.pre && !pb.pre) {
    return -1;
  }
  if (!pa.pre && !pb.pre) {
    return 0;
  }
  // When both are prereleases, compare each prerelease segment in order.
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    // Compare numerically when both segments are numbers.
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) {
        return aNum - bNum;
      }
    } else {
      // Fall back to lexical comparison for string segments.
      if (aP < bP) {
        return -1;
      }
      if (aP > bP) {
        return 1;
      }
    }
  }
  return 0;
}
