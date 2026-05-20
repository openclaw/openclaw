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

export function resolveAuthContext(req: IncomingMessage, runtime: ClaworksRuntime): AuthContext {
  const expected = runtime.config.api?.api_key?.trim();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const channelUser = readChannelUserHeader(req);

  if (!expected) {
    if (channelUser) {
      return { authenticated: true, subjectType: "channel_user", subjectId: channelUser };
    }
    return { authenticated: true, subjectType: "system", subjectId: "local" };
  }

  if (token === expected) {
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
