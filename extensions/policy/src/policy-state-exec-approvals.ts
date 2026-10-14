import {
  asNonArrayRecord,
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { execApprovalsPolicyUri } from "./exec-approvals-uri.js";
import { ocPathSegment } from "./policy-state-helpers.js";
import type { PolicyExecApprovalEvidence } from "./policy-state-types.js";

export function scanPolicyExecApprovals(raw: string): readonly PolicyExecApprovalEvidence[] {
  const parsed = parseExecApprovalsFile(raw);
  if (!parsed.ok) {
    return [];
  }
  const evidence: PolicyExecApprovalEvidence[] = [];
  const defaults = asNonArrayRecord(parsed.value.defaults);
  evidence.push(
    execApprovalPostureEvidence(
      "defaults",
      "defaults",
      defaults,
      execApprovalsPolicyUri("defaults"),
    ),
  );

  // Snapshot admission leaves legacy agent and allowlist migration to Doctor.
  for (const [agentId, value] of Object.entries(asNonArrayRecord(parsed.value.agents)).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (!isRecord(value)) {
      continue;
    }
    const agentSource = execApprovalsPolicyUri(`agents/${ocPathSegment(agentId)}`);
    evidence.push(
      execApprovalPostureEvidence(`agent:${agentId}`, "agent", value, agentSource, agentId),
    );
    if (!Array.isArray(value.allowlist)) {
      continue;
    }
    let allowlistIndex = 0;
    for (const [index, entry] of value.allowlist.entries()) {
      if (!isRecord(entry)) {
        continue;
      }
      const pattern = readString(entry.pattern);
      if (pattern === undefined) {
        continue;
      }
      const argPattern = readString(entry.argPattern);
      const entrySource = readString(entry.source) === "allow-always" ? "allow-always" : undefined;
      evidence.push({
        id: `agent:${agentId}:allowlist:${allowlistIndex++}`,
        kind: "allowlist",
        source: `${agentSource}/allowlist/#${index}`,
        agentId,
        pattern,
        ...(argPattern === undefined ? {} : { argPattern }),
        ...(entrySource === undefined ? {} : { entrySource }),
      });
    }
  }
  return evidence;
}

export function parseExecApprovalsFile(
  raw: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string } {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) {
      return { ok: false, message: "unsupported exec approvals version" };
    }
    return { ok: true, value };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function execApprovalPostureEvidence(
  id: string,
  kind: "agent" | "defaults",
  value: Record<string, unknown>,
  source: string,
  agentId?: string,
): PolicyExecApprovalEvidence {
  const security = readExecApprovalSecurity(value.security);
  const ask = readExecApprovalAsk(value.ask);
  const askFallback = readExecApprovalSecurity(value.askFallback);
  const autoAllowSkills = readBoolean(value.autoAllowSkills);
  return {
    id,
    kind,
    source,
    ...(agentId === undefined ? {} : { agentId }),
    ...(value.security == null ? {} : { securityConfigured: true }),
    ...(security === undefined ? {} : { security }),
    ...(ask === undefined ? {} : { ask }),
    ...(askFallback === undefined ? {} : { askFallback }),
    ...(autoAllowSkills === undefined ? {} : { autoAllowSkills }),
  };
}

function readExecApprovalSecurity(value: unknown): string | undefined {
  const normalized = readString(value);
  return normalized === "deny" || normalized === "allowlist" || normalized === "full"
    ? normalized
    : undefined;
}

function readExecApprovalAsk(value: unknown): string | undefined {
  const normalized = readString(value);
  return normalized === "off" || normalized === "on-miss" || normalized === "always"
    ? normalized
    : undefined;
}
