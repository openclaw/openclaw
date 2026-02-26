import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

const log = createSubsystemLogger("agents/tools");

const TRUTHY = new Set(["1", "true", "yes", "y", "on", "approved", "approve", "allow"]);

const DEFAULT_APPROVAL_REQUIRED_TOOLS = [
  "web_search",
  "web_fetch",
  "message",
  "exec",
  "browser",
  "gateway",
  "nodes",
  "cron",
  "sessions_send",
  "sessions_spawn",
  "subagents",
];

const DESTRUCTIVE_CMD_RX =
  /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown\b|reboot\b|halt\b|poweroff\b|diskutil\s+erase|format\s+[a-z]:|chmod\s+-R\s+777|chown\s+-R\s+root|killall\b)\b/i;
const PROMPT_INJECTION_RX =
  /\b(ignore\s+previous\s+instructions|delete\s+all\s+logs|exfiltrate|disable\s+security)\b/i;

function parseBooleanLike(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return TRUTHY.has(value.trim().toLowerCase());
}

function isSentinelEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseBooleanLike(env.OPENCLAW_SECURITY_SENTINEL_ENABLED ?? "");
}

function resolveApprovalRequiredTools(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.OPENCLAW_SECURITY_SENTINEL_REQUIRE_APPROVAL_TOOLS?.trim();
  if (!raw) {
    return new Set(DEFAULT_APPROVAL_REQUIRED_TOOLS);
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeToolName(entry))
      .filter((entry) => entry.length > 0),
  );
}

function resolveApprovalFlag(params: unknown): boolean {
  if (!isPlainObject(params)) {
    return false;
  }
  return (
    parseBooleanLike(params.securitySentinelApproved) ||
    parseBooleanLike(params.operatorApproved) ||
    parseBooleanLike(params.approved) ||
    parseBooleanLike(params.approval)
  );
}

function extractPotentialCommand(params: unknown): string {
  if (!isPlainObject(params)) {
    return "";
  }
  const direct = [params.cmd, params.command, params.chars];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (isPlainObject(params.params)) {
    const nested = [params.params.cmd, params.params.command, params.params.chars];
    for (const candidate of nested) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "";
}

function resolveAuditPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_SECURITY_SENTINEL_AUDIT_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveStateDir(env), "logs", "security-sentinel.jsonl");
}

function summarizeParams(params: unknown): Record<string, unknown> {
  if (!isPlainObject(params)) {
    return {};
  }
  const summary: Record<string, unknown> = {
    keys: Object.keys(params),
  };
  const cmd = extractPotentialCommand(params);
  if (cmd) {
    summary.commandPreview = cmd.slice(0, 160);
  }
  return summary;
}

export type SecuritySentinelDecision = {
  active: boolean;
  blocked: boolean;
  reason?: string;
  tamperType?: string;
  toolName: string;
  approved: boolean;
  approvalRequired: boolean;
  riskScore: number;
  matched: string[];
};

function classifyTamperType(args: {
  approvalRequired: boolean;
  approved: boolean;
  matched: string[];
}): string | undefined {
  if (
    args.matched.includes("prompt_injection_pattern") &&
    args.matched.includes("destructive_command")
  ) {
    return "prompt_injection_destructive";
  }
  if (args.matched.includes("prompt_injection_pattern")) {
    return "prompt_injection_attempt";
  }
  if (args.matched.includes("destructive_command")) {
    return "destructive_command_attempt";
  }
  if (args.approvalRequired && !args.approved) {
    return "unauthorized_sensitive_tool_use";
  }
  return undefined;
}

export function evaluateSecuritySentinel(args: {
  toolName: string;
  params: unknown;
  env?: NodeJS.ProcessEnv;
}): SecuritySentinelDecision {
  const env = args.env ?? process.env;
  const toolName = normalizeToolName(args.toolName || "tool");
  const active = isSentinelEnabled(env);
  if (!active) {
    return {
      active: false,
      blocked: false,
      toolName,
      approved: false,
      approvalRequired: false,
      riskScore: 0,
      matched: [],
    };
  }

  const approvalRequiredTools = resolveApprovalRequiredTools(env);
  const approvalRequired = approvalRequiredTools.has(toolName);
  const approved = resolveApprovalFlag(args.params);
  const matched: string[] = [];
  let riskScore = approvalRequired ? 70 : 10;

  const command = extractPotentialCommand(args.params);
  if (command) {
    if (DESTRUCTIVE_CMD_RX.test(command)) {
      riskScore = Math.max(riskScore, 90);
      matched.push("destructive_command");
    }
    if (PROMPT_INJECTION_RX.test(command)) {
      riskScore = Math.max(riskScore, 85);
      matched.push("prompt_injection_pattern");
    }
  }

  if (approvalRequired && !approved) {
    matched.push("approval_required_tool");
    const tamperType = classifyTamperType({ approvalRequired, approved, matched });
    const reasonPrefix = tamperType ? `tamper_type=${tamperType}; ` : "";
    return {
      active: true,
      blocked: true,
      reason: `${reasonPrefix}explicit operator approval required (set securitySentinelApproved=true for this tool call)`,
      tamperType,
      toolName,
      approved,
      approvalRequired,
      riskScore,
      matched,
    };
  }

  const tamperType = classifyTamperType({ approvalRequired, approved, matched });

  return {
    active: true,
    blocked: false,
    tamperType,
    toolName,
    approved,
    approvalRequired,
    riskScore,
    matched,
  };
}

export async function writeSecuritySentinelAudit(args: {
  decision: SecuritySentinelDecision;
  params: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!args.decision.active) {
    return;
  }
  const env = args.env ?? process.env;
  const auditPath = resolveAuditPath(env);
  const shouldWrite =
    args.decision.blocked || args.decision.approvalRequired || args.decision.riskScore >= 80;
  if (!shouldWrite) {
    return;
  }

  const event = {
    ts: new Date().toISOString(),
    tool: args.decision.toolName,
    blocked: args.decision.blocked,
    reason: args.decision.reason ?? null,
    tamperType: args.decision.tamperType ?? null,
    approved: args.decision.approved,
    approvalRequired: args.decision.approvalRequired,
    riskScore: args.decision.riskScore,
    matched: args.decision.matched,
    params: summarizeParams(args.params),
  };

  try {
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch (err) {
    log.warn(`security sentinel audit write failed: path=${auditPath} error=${String(err)}`);
  }
}
