import {
  asProtocolRecord,
  normalizeOptionalProtocolString,
} from "./protocol-value-normalization.js";
import type { SchemaContract } from "./schema-contract.js";

export const INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED =
  "install_policy_warning_acknowledgement_required" as const;

type InstallPolicyWarningErrorFinding = SchemaContract<NonNullable<ReturnType<typeof readFinding>>>;

export type InstallPolicyWarningErrorDetails = {
  installPolicyCode: typeof INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED;
  targetName: string;
  targetType: "skill" | "plugin";
  requestMode: "install" | "update";
  reason: string;
  findings?: InstallPolicyWarningErrorFinding[];
};

function readFinding(value: unknown) {
  const record = asProtocolRecord(value);
  if (!record) {
    return undefined;
  }
  const ruleId = normalizeOptionalProtocolString(record.ruleId);
  const message = normalizeOptionalProtocolString(record.message);
  const rawSeverity = record.severity;
  if (
    !ruleId ||
    !message ||
    (rawSeverity !== "info" && rawSeverity !== "warn" && rawSeverity !== "critical")
  ) {
    return undefined;
  }
  const severity: "info" | "warn" | "critical" = rawSeverity;
  const file = normalizeOptionalProtocolString(record.file);
  const evidence = normalizeOptionalProtocolString(record.evidence);
  const line = record.line;
  if (
    (record.file !== undefined && !file) ||
    (record.evidence !== undefined && !evidence) ||
    (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0))
  ) {
    return undefined;
  }
  return {
    ruleId,
    severity,
    message,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function readInstallPolicyWarningErrorDetails(
  value: unknown,
): InstallPolicyWarningErrorDetails | undefined {
  const record = asProtocolRecord(value);
  if (!record) {
    return undefined;
  }
  const targetName = normalizeOptionalProtocolString(record.targetName);
  const reason = normalizeOptionalProtocolString(record.reason);
  const rawTargetType = record.targetType;
  const rawRequestMode = record.requestMode;
  if (
    record.installPolicyCode !== INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED ||
    !targetName ||
    !reason ||
    (rawTargetType !== "skill" && rawTargetType !== "plugin") ||
    (rawRequestMode !== "install" && rawRequestMode !== "update")
  ) {
    return undefined;
  }
  const targetType: "skill" | "plugin" = rawTargetType;
  const requestMode: "install" | "update" = rawRequestMode;
  let findings: InstallPolicyWarningErrorFinding[] | undefined;
  if (record.findings !== undefined) {
    if (!Array.isArray(record.findings)) {
      return undefined;
    }
    findings = [];
    for (const findingValue of record.findings) {
      const finding = readFinding(findingValue);
      if (!finding) {
        return undefined;
      }
      findings.push(finding);
    }
  }
  return {
    installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
    targetName,
    targetType,
    requestMode,
    reason,
    ...(findings ? { findings } : {}),
  };
}
