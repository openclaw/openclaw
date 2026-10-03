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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    return [];
  }
  const evidence: PolicyExecApprovalEvidence[] = [];
  const defaults = asNonArrayRecord(parsed.defaults);
  evidence.push(
    execApprovalPostureEvidence(
      "defaults",
      "defaults",
      defaults,
      execApprovalsPolicyUri("defaults"),
    ),
  );

  // Snapshot admission leaves legacy agent and allowlist migration to Doctor.
  for (const [agentId, value] of Object.entries(asNonArrayRecord(parsed.agents)).toSorted(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (!isRecord(value)) {
      continue;
    }
    const agentSource = execApprovalsPolicyUri(`agents/${ocPathSegment(agentId)}`);
    evidence.push(
      execApprovalPostureEvidence(`agent:${agentId}`, "agent", value, agentSource, agentId),
    );
    for (const [index, entry] of execApprovalAllowlistEntries(value.allowlist).entries()) {
      const allowlistSource = execApprovalsPolicyUri(
        `agents/${ocPathSegment(agentId)}/allowlist/#${entry.index}`,
      );
      evidence.push({
        id: `agent:${agentId}:allowlist:${index}`,
        kind: "allowlist",
        source: allowlistSource,
        agentId,
        pattern: entry.pattern,
        ...(entry.argPattern === undefined ? {} : { argPattern: entry.argPattern }),
        ...(entry.entrySource === undefined ? {} : { entrySource: entry.entrySource }),
      });
    }
  }
  return evidence;
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

function execApprovalAllowlistEntries(value: unknown): readonly {
  readonly index: number;
  readonly pattern: string;
  readonly argPattern?: string;
  readonly entrySource?: string;
}[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: {
    readonly index: number;
    readonly pattern: string;
    readonly argPattern?: string;
    readonly entrySource?: string;
  }[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const pattern = readString(entry.pattern);
    if (pattern === undefined) {
      continue;
    }
    const argPattern = readString(entry.argPattern);
    const entrySource = readString(entry.source) === "allow-always" ? "allow-always" : undefined;
    entries.push({
      index,
      pattern,
      ...(argPattern === undefined ? {} : { argPattern }),
      ...(entrySource === undefined ? {} : { entrySource }),
    });
  }
  return entries;
}
