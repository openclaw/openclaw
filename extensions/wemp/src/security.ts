import { formatPairingApproveHint } from "openclaw/plugin-sdk";
import type { ResolvedWempAccount } from "./types.js";

function normalizeAllowFrom(policy: string, allowFrom: string[]): string[] {
  const normalized = Array.from(
    new Set(
      (Array.isArray(allowFrom) ? allowFrom : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );
  if (policy === "disabled") return [];
  if (policy === "open") {
    return normalized.includes("*") ? normalized : ["*", ...normalized];
  }
  return normalized;
}

export function resolveDmPolicy(account: ResolvedWempAccount) {
  const useAccountPath = account.accountId !== "default";
  const basePath = useAccountPath
    ? `channels.wemp.accounts.${account.accountId}.`
    : "channels.wemp.";
  const policy = String(account.dm.policy || "pairing");
  return {
    policy,
    allowFrom: normalizeAllowFrom(policy, account.dm.allowFrom),
    normalizeEntry: (raw: string) => String(raw || "").trim(),
    policyPath: `${basePath}dm.policy`,
    allowFromPath: `${basePath}dm.allowFrom`,
    approveHint: formatPairingApproveHint("wemp"),
  };
}

export function collectWarnings(account: ResolvedWempAccount): string[] {
  const warnings: string[] = [];
  if (account.dm.policy === "open") {
    warnings.push(
      `- WeChat MP: dm.policy="open" allows any follower to interact without pairing. Set channels.wemp.dm.policy="pairing" or "allowlist" to restrict access.`,
    );
  }
  if (!account.appId || !account.appSecret || !account.token) {
    warnings.push(
      `- WeChat MP: missing required credentials (appId/appSecret/token). Channel will not function.`,
    );
  }
  return warnings;
}
