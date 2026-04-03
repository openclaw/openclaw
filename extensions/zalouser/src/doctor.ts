import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { collectProviderDangerousNameMatchingScopes } from "openclaw/plugin-sdk/runtime";
import { isZalouserMutableGroupEntry } from "./security-audit.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeForLog(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function collectZalouserMutableAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const hits: Array<{ path: string; entry: string }> = [];

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "zalouser")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    const groups = asObjectRecord(scope.account.groups);
    if (!groups) {
      continue;
    }
    for (const entry of Object.keys(groups)) {
      if (isZalouserMutableGroupEntry(entry)) {
        hits.push({ path: `${scope.prefix}.groups`, entry });
      }
    }
  }

  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across zalouser while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    "- Option A (break-glass): enable channels.zalouser.dangerousNameMatching=true for the affected scope.",
    "- Option B (recommended): resolve mutable group names to stable IDs and rewrite the allowlist entries.",
  ];
}

export const zalouserDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "hybrid",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  collectMutableAllowlistWarnings: ({ cfg }) => collectZalouserMutableAllowlistWarnings(cfg),
};
