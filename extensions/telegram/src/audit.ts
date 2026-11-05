import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  AuditTelegramGroupMembershipParams,
  TelegramGroupMembershipAudit,
} from "./audit.types.js";

export function collectTelegramUnmentionedGroupIds(
  groups: Record<string, TelegramGroupConfig> | undefined,
) {
  const configuredGroups = groups && typeof groups === "object" ? groups : undefined;
  const hasWildcardUnmentionedGroups =
    configuredGroups?.["*"]?.requireMention === false && configuredGroups?.["*"]?.enabled !== false;
  const groupIds: string[] = [];
  let unresolvedGroups = 0;
  for (const [key, value] of Object.entries(configuredGroups ?? {})) {
    if (
      key === "*" ||
      !value ||
      typeof value !== "object" ||
      value.enabled === false ||
      value.requireMention !== false
    ) {
      continue;
    }
    const id = normalizeOptionalString(key) ?? "";
    if (!id) {
      continue;
    }
    if (/^-?\d+$/.test(id)) {
      groupIds.push(id);
    } else {
      unresolvedGroups += 1;
    }
  }
  groupIds.sort((a, b) => a.localeCompare(b));
  return { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups };
}

export async function auditTelegramGroupMembership(
  params: AuditTelegramGroupMembershipParams,
): Promise<TelegramGroupMembershipAudit> {
  const started = Date.now();
  const token = normalizeOptionalString(params.token) ?? "";
  if (!token || params.groupIds.length === 0) {
    return {
      ok: true,
      checkedGroups: 0,
      unresolvedGroups: 0,
      hasWildcardUnmentionedGroups: false,
      groups: [],
      elapsedMs: Date.now() - started,
    };
  }

  // Lazy import to avoid pulling `undici` (ProxyAgent) into cold-path callers that only need
  // `collectTelegramUnmentionedGroupIds` (e.g. config audits).
  const { auditTelegramGroupMembershipImpl } = await import("./audit-membership-runtime.js");
  const result = await auditTelegramGroupMembershipImpl({
    ...params,
    token,
  });
  return {
    ...result,
    elapsedMs: Date.now() - started,
  };
}
