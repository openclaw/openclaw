import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { WecomAccountConfig } from "../types.js";

function normalizeWecomAllowFromEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^wecom:/, "")
    .replace(/^user:/, "")
    .replace(/^userid:/, "");
}

function isWecomSenderAllowed(senderUserId: string, allowFrom: string[]): boolean {
  const list = allowFrom.map((entry) => normalizeWecomAllowFromEntry(entry)).filter(Boolean);
  if (list.includes("*")) return true;
  const normalizedSender = normalizeWecomAllowFromEntry(senderUserId);
  if (!normalizedSender) return false;
  return list.includes(normalizedSender);
}

export async function resolveWecomCommandAuthorization(params: {
  core: PluginRuntime;
  cfg: OpenClawConfig;
  accountConfig: WecomAccountConfig;
  rawBody: string;
  senderUserId: string;
}): Promise<{
  shouldComputeAuth: boolean;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  senderAllowed: boolean;
  authorizerConfigured: boolean;
  commandAuthorized: boolean | undefined;
  effectiveAllowFrom: string[];
}> {
  const { core, cfg, accountConfig, rawBody, senderUserId } = params;

  const dmPolicy = (accountConfig.dm?.policy ?? "pairing") as
    | "pairing"
    | "allowlist"
    | "open"
    | "disabled";
  const configAllowFrom = (accountConfig.dm?.allowFrom ?? []).map((v) => String(v));

  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg);
  // WeCom channel currently does NOT support the `openclaw pairing` CLI workflow
  // ("Channel wecom does not support pairing"). So we must not rely on pairing
  // store approvals for command authorization here.
  //
  // Policy semantics:
  // - open: commands are allowed for everyone by default (unless higher-level access-groups deny).
  // - allowlist: commands require allowFrom entries.
  // - pairing: treated the same as allowlist for WeCom (since pairing CLI is unsupported).
  const effectiveAllowFrom = dmPolicy === "open" ? ["*"] : configAllowFrom;

  const senderAllowed = isWecomSenderAllowed(senderUserId, effectiveAllowFrom);
  const allowAllConfigured = effectiveAllowFrom.some(
    (entry) => normalizeWecomAllowFromEntry(entry) === "*",
  );
  const authorizerConfigured = allowAllConfigured || effectiveAllowFrom.length > 0;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;

  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: authorizerConfigured, allowed: senderAllowed }],
      })
    : undefined;

  return {
    shouldComputeAuth,
    dmPolicy,
    senderAllowed,
    authorizerConfigured,
    commandAuthorized,
    effectiveAllowFrom,
  };
}

export function buildWecomUnauthorizedCommandPrompt(params: {
  senderUserId: string;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  scope: "bot" | "agent";
}): string {
  const user = params.senderUserId || "unknown";
  const policy = params.dmPolicy;
  const scopeLabel = params.scope === "bot" ? "Bot（智能机器人）" : "Agent（自建应用）";
  const dmPrefix = params.scope === "bot" ? "channels.wecom.bot.dm" : "channels.wecom.agent.dm";
  const allowCmd = (value: string) => `openclaw config set ${dmPrefix}.allowFrom '${value}'`;
  const policyCmd = (value: string) => `openclaw config set ${dmPrefix}.policy "${value}"`;

  if (policy === "disabled") {
    return [
      `无权限执行命令（${scopeLabel} 已禁用：dm.policy=disabled）`,
      `触发者：${user}`,
      `管理员：${policyCmd("open")}（全放开）或 ${policyCmd("allowlist")}（白名单）`,
    ].join("\n");
  }
  // WeCom 不支持 pairing CLI，因此这里统一给出“open / allowlist”两种明确的配置指令
  return [
    `无权限执行命令（入口：${scopeLabel}，userid：${user}）`,
    `管理员全放开：${policyCmd("open")}`,
    `管理员放行该用户：${policyCmd("allowlist")}`,
    `然后设置白名单：${allowCmd(JSON.stringify([user]))}`,
    `如果仍被拦截：检查 commands.useAccessGroups/访问组`,
  ].join("\n");
}
