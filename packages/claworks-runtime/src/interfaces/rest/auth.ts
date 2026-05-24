import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RbacCheckInput } from "../../claworks/robot-identity.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";

export type AuthContext = {
  authenticated: boolean;
  subjectType: RbacCheckInput["subjectType"];
  subjectId: string;
};

/**
 * 验证请求认证 + 提取主体上下文，供 RBAC 使用。
 * - 有 api_key 配置时：Bearer Token 必须匹配，主体类型为 apikey
 * - 无 api_key 配置时：本地开发模式，主体为 system（始终允许）
 */
function readChannelUserHeader(req: IncomingMessage): string {
  const raw = req.headers["x-claworks-channel-user"];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (Array.isArray(raw) && raw[0]?.trim()) {
    return raw[0].trim();
  }
  return "";
}

/**
 * 对 API 密钥进行 SHA-256 哈希，用于存储哈希值的配置场景。
 * 返回 64 位小写十六进制字符串。
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * 判断请求 token 是否匹配配置中存储的密钥值。
 * 向后兼容：
 *   - 存储值长度 < 32：视为明文，直接比对
 *   - 存储值长度 >= 32：视为 SHA-256 哈希，对 token 哈希后比对
 */
function matchesKey(token: string, stored: string): boolean {
  if (stored.length < 32) {
    return token === stored;
  }
  return hashApiKey(token) === stored;
}

/**
 * 收集所有有效 API 密钥（primary + rotation list），去除空值。
 * 支持多密钥并行（密钥轮换不中断服务）。
 */
function collectValidKeys(runtime: ClaworksRuntime): string[] {
  const keys: string[] = [];
  const primary = runtime.config.api?.api_key?.trim();
  if (primary) keys.push(primary);
  for (const k of runtime.config.api?.api_keys ?? []) {
    const t = k?.trim();
    if (t && !keys.includes(t)) keys.push(t);
  }
  return keys;
}

export function resolveAuthContext(req: IncomingMessage, runtime: ClaworksRuntime): AuthContext {
  const validKeys = collectValidKeys(runtime);
  const requireApiKey = runtime.config.api?.require_api_key === true;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const channelUser = readChannelUserHeader(req);

  if (validKeys.length === 0) {
    // require_api_key=true but no api_key configured → deny (misconfigured, fail safe)
    if (requireApiKey) {
      return { authenticated: false, subjectType: "apikey", subjectId: "unknown" };
    }
    if (channelUser) {
      return { authenticated: true, subjectType: "channel_user", subjectId: channelUser };
    }
    return { authenticated: true, subjectType: "system", subjectId: "local" };
  }

  if (token && validKeys.some((k) => matchesKey(token, k))) {
    if (channelUser) {
      return { authenticated: true, subjectType: "channel_user", subjectId: channelUser };
    }
    const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 12);
    return { authenticated: true, subjectType: "apikey", subjectId: `apikey:${tokenHash}` };
  }

  return { authenticated: false, subjectType: "apikey", subjectId: "unknown" };
}

/** 旧版兼容：只返回 boolean（内部模块仍可用） */
export function checkClaworksApiAuth(req: IncomingMessage, runtime: ClaworksRuntime): boolean {
  return resolveAuthContext(req, runtime).authenticated;
}

/**
 * RBAC 权限检查（非 HTTP 中间件，作为函数调用）。
 * 返回 denied 时，调用方负责发 403 并发布 rbac.denied 事件（供 Playbook 响应）。
 */
export function checkRbac(
  runtime: ClaworksRuntime,
  auth: AuthContext,
  action: string,
  resource: string,
): { allowed: true } | { allowed: false; reason: string } {
  return runtime.rbac.check({
    action,
    resource,
    subjectType: auth.subjectType,
    subjectId: auth.subjectId,
  });
}
