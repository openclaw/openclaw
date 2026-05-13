/**
 * DingTalk Connector SDK Helpers
 * 
 * 完全独立的辅助函数，不依赖任何外部 SDK。
 */

import type { SecretInput, SecretInputRef } from "./types.ts";

// ============================================================================
// 账号 ID 处理
// ============================================================================

/**
 * 默认账号 ID
 */
export const DEFAULT_ACCOUNT_ID = "__default__" as const;

/**
 * 规范化账号 ID
 *
 * 注意：账号 ID 保留原始大小写，仅做 trim 处理。
 * 不做 toLowerCase，因为配置文件中的 accounts key 是大小写敏感的，
 * 如 "zhizaoDashuIP" 与 "zhizaodashuip" 是不同的账号。
 * 特殊值 "default"（不区分大小写）和空字符串映射到 DEFAULT_ACCOUNT_ID。
 */
export function normalizeAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (trimmed.toLowerCase() === "default" || trimmed === "") {
    return DEFAULT_ACCOUNT_ID;
  }
  return trimmed;
}

// ============================================================================
// SecretInput 处理
// ============================================================================

/**
 * 判断是否为 SecretInput 引用
 */
export function isSecretInputRef(value: unknown): value is SecretInputRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const ref = value as SecretInputRef;
  return (
    typeof ref.source === "string" &&
    ["env", "file", "exec"].includes(ref.source) &&
    typeof ref.provider === "string" &&
    ref.provider.length > 0 &&
    typeof ref.id === "string" &&
    ref.id.length > 0
  );
}

/**
 * 规范化 SecretInput 字符串
 * 用于显示和日志，会隐藏敏感信息
 */
export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  
  if (isSecretInputRef(value)) {
    const ref = value as SecretInputRef;
    return `<${ref.source}:${ref.provider}:${ref.id}>`;
  }
  
  return undefined;
}

/**
 * 解析 SecretInput 为实际值
 * 用于运行时获取实际的敏感信息
 */
export function resolveSecretInputValue(
  value: unknown,
  options?: { allowEnvRead?: boolean },
): string | undefined {
  // 直接字符串
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  
  // SecretInput 引用
  if (isSecretInputRef(value)) {
    const ref = value as SecretInputRef;
    
    // 环境变量
    if (ref.source === "env" && options?.allowEnvRead) {
      const envValue = process.env[ref.id];
      if (typeof envValue === "string") {
        return envValue.trim() || undefined;
      }
    }
    
    // 文件或执行 - 返回引用字符串
    return `<${ref.source}:${ref.provider}:${ref.id}>`;
  }
  
  return undefined;
}

/**
 * 检查 SecretInput 是否已配置
 */
export function hasConfiguredSecretInput(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  
  if (isSecretInputRef(value)) {
    const ref = value as SecretInputRef;
    if (ref.source === "env") {
      return typeof process.env[ref.id] === "string" && process.env[ref.id]!.trim().length > 0;
    }
    // file 和 exec 总是认为已配置（运行时会验证）
    return true;
  }
  
  return false;
}

/**
 * 规范化已解析的 SecretInput 字符串
 * 用于配置验证和错误提示
 */
export function normalizeResolvedSecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const { value, path } = params;
  
  // 直接字符串
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
    throw new Error(`${path} must be a non-empty string`);
  }
  
  // SecretInput 引用
  if (isSecretInputRef(value)) {
    const ref = value as SecretInputRef;
    
    // 验证引用格式
    if (!["env", "file", "exec"].includes(ref.source)) {
      throw new Error(`${path}.source must be one of: env, file, exec`);
    }
    if (typeof ref.provider !== "string" || !ref.provider.trim()) {
      throw new Error(`${path}.provider must be a non-empty string`);
    }
    if (typeof ref.id !== "string" || !ref.id.trim()) {
      throw new Error(`${path}.id must be a non-empty string`);
    }
    
    // 环境变量特殊处理
    if (ref.source === "env") {
      const envValue = process.env[ref.id];
      if (!envValue || !envValue.trim()) {
        throw new Error(`${path}: environment variable ${ref.id} is not set`);
      }
      return envValue.trim();
    }
    
    // file 和 exec 返回引用字符串
    return `<${ref.source}:${ref.provider}:${ref.id}>`;
  }
  
  throw new Error(`${path} must be a string or SecretInput object`);
}

// ============================================================================
// 群组策略处理
// ============================================================================

/**
 * 解析默认群组策略
 */
export function resolveDefaultGroupPolicy(cfg: {
  channels?: { [key: string]: unknown };
}): "open" | "allowlist" | "disabled" {
  const dingtalkCfg = cfg.channels?.["dingtalk-connector"] as {
    groupPolicy?: "open" | "allowlist" | "disabled";
  } | undefined;
  return dingtalkCfg?.groupPolicy ?? "open";
}

/**
 * 解析允许列表提供者运行时群组策略
 */
export function resolveAllowlistProviderRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: "open" | "allowlist" | "disabled";
  defaultGroupPolicy: "open" | "allowlist" | "disabled";
}): { groupPolicy: "open" | "allowlist" | "disabled" } {
  const { providerConfigPresent, groupPolicy, defaultGroupPolicy } = params;
  
  if (groupPolicy) {
    return { groupPolicy };
  }
  
  if (providerConfigPresent) {
    return { groupPolicy: defaultGroupPolicy };
  }
  
  return { groupPolicy: "disabled" };
}

// ============================================================================
// 通道状态处理
// ============================================================================

/**
 * 创建默认通道运行时状态
 */
export function createDefaultChannelRuntimeState(
  accountId: string,
  extras?: Record<string, unknown>,
): {
  running: boolean;
  lastStartAt: string | null;
  lastStopAt: string | null;
  lastError: string | null;
  port: number | null;
  accountId: string;
} {
  return {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
    port: null,
    accountId,
    ...extras,
  };
}

/**
 * 构建基础通道状态摘要
 */
export function buildBaseChannelStatusSummary(snapshot: {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  running?: boolean;
  lastStartAt?: string | null;
  lastStopAt?: string | null;
  lastError?: string | null;
}): {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  running: boolean;
  lastStartAt: string | null;
  lastStopAt: string | null;
  lastError: string | null;
} {
  return {
    accountId: snapshot.accountId,
    enabled: snapshot.enabled,
    configured: snapshot.configured,
    name: snapshot.name,
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

// ============================================================================
// 其他辅助函数
// ============================================================================

/**
 * 添加通配符到 allowFrom
 */
export function addWildcardAllowFrom(
  existing?: (string | number)[],
): (string | number)[] {
  if (!existing || existing.length === 0) {
    return ["*"];
  }
  if (existing.includes("*")) {
    return existing;
  }
  return [...existing, "*"];
}

/**
 * 格式化文档链接
 */
export function formatDocsLink(path: string, label: string): string {
  return `https://docs.openclaw.ai${path}`;
}

/**
 * 规范化字符串
 */
export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * 解析 allowFrom 输入
 */
export function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
