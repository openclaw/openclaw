/**
 * Webhook Target management
 *
 * Migrated from the @mocrane/wecom monitor.ts implementation (Webhook Target portion only).
 * Maintains the global list of registered Targets and provides register/unregister/query operations.
 *
 * Targets are indexed by path: Map<path, WecomWebhookTarget[]>
 * Multiple accounts may be registered under the same path (legacy-path compatibility mode), and signature verification is used to match the correct account.
 */

import type { WecomWebhookTarget } from "./types.js";

// ============================================================================
// Global Target registry (indexed by path)
// ============================================================================

/** Registered Webhook Targets (indexed by path) */
const webhookTargets = new Map<string, WecomWebhookTarget[]>();

// ============================================================================
// Path helper functions
// ============================================================================

/**
 * Normalize a Webhook path
 *
 * Canonical format: starts with `/` and does not end with `/`.
 */
function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

/**
 * 去除重复路径
 */
function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((p) => normalizeWebhookPath(p)).filter(Boolean)));
}

// ============================================================================
// 注册 / 注销
// ============================================================================

/**
 * 注册 Webhook Target（单条路径）
 *
 * 将 Target 加入指定路径的列表中，返回注销函数。
 */
function registerTargetForPath(path: string, target: WecomWebhookTarget): () => void {
  const key = normalizeWebhookPath(path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, normalizedTarget]);

  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

/**
 * 注册 Webhook Target（多条路径）
 *
 * 为每条路径分别注册 Target，返回一个注销函数（一次性注销所有路径）。
 */
export function registerWecomWebhookTarget(
  target: WecomWebhookTarget,
  paths: string[],
): () => void {
  const unregisters: Array<() => void> = [];

  for (const path of uniquePaths(paths)) {
    unregisters.push(registerTargetForPath(path, target));
  }

  return () => {
    for (const unregister of unregisters) {
      unregister();
    }
  };
}

/**
 * 获取全局 Target 注册表
 *
 * 返回完整的 Map<path, Target[]>，供 handler.ts 路由匹配使用。
 */
export function getWebhookTargetsMap(): ReadonlyMap<string, WecomWebhookTarget[]> {
  return webhookTargets;
}

/**
 * 获取所有已注册的 Webhook Target（扁平列表）
 *
 * 用于无法精确匹配路径时的逐一签名验证场景。
 */
export function getRegisteredTargets(): WecomWebhookTarget[] {
  const seen = new Set<WecomWebhookTarget>();
  const result: WecomWebhookTarget[] = [];
  for (const list of webhookTargets.values()) {
    for (const target of list) {
      if (!seen.has(target)) {
        seen.add(target);
        result.push(target);
      }
    }
  }
  return result;
}

/**
 * 判断是否有活跃 Target
 */
export function hasActiveTargets(): boolean {
  return webhookTargets.size > 0;
}

/**
 * 从 URL 中解析 accountId（多账号路径）
 *
 * 支持路径格式：
 * - /plugins/wecom/bot/{accountId}
 * - /wecom/bot/{accountId}
 * - /wecom/{accountId}
 */
export function parseWebhookPath(url: string): string | undefined {
  const patterns = [
    /\/plugins\/wecom\/bot\/([^/?]+)/,
    /\/wecom\/bot\/([^/?]+)/,
    /\/wecom\/([^/?]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) {
      const segment = match[1];
      // 排除已知的非 accountId 路径段
      if (segment === "bot") {
        continue;
      }
      return segment;
    }
  }
  return undefined;
}
