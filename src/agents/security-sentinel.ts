import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPlainObject } from "../utils.js";
import { normalizeToolName } from "./tool-policy.js";

const log = createSubsystemLogger("agents/tools");

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);

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
const DEFAULT_APPROVAL_GRANT_USES = 2;
const DEFAULT_APPROVAL_GRANT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_STRICT_APPROVAL_CHANNELS = ["signal"];
const DEFAULT_PASSPHRASE_REQUIRED_TOOLS = ["message"];
const MAX_APPROVAL_GRANT_KEYS = 2048;

// Catches destructive shell commands in tool parameters.
// Covers flag-order variants (rm -rf / rm -fr / rm -r), long-form flags, disk tools,
// shell redirects to block/character devices, and pipe-to-shell execution.
const DESTRUCTIVE_CMD_RX =
  /\b(rm\s+-[^\s]*r[^\s]*f|rm\s+--recursive|rm\s+--force|rm\s+-r\b|mkfs|dd\s+if=|dd\s+of=|shutdown\b|reboot\b|halt\b|poweroff\b|diskutil\s+erase|format\s+[a-z]:|chmod\s+-R\s+777|chown\s+-R\s+root|killall\b|shred\b|wipe\b|fdisk\b|truncate\s+-s\s+0)\b|>\s*\/dev\/(sd[a-z]|nvme|disk|hd[a-z])|\|\s*(bash|sh|zsh|python3?|node|ruby|perl)\b/i;
// Catches common prompt-injection phrases that attempt to override agent behaviour.
// Deliberately broad to catch natural-language variants; false-positive risk is low
// because these phrases are rarely in legitimate tool payloads.
const PROMPT_INJECTION_RX =
  /\b(ignore\s+(previous|prior|all|your)\s+(instructions?|rules?|guidelines?|constraints?)|disregard\s+(previous|prior|all|your)\s+(instructions?|rules?|guidelines?)|forget\s+(previous|prior|all|your)\s+(instructions?|rules?|guidelines?)|new\s+(system\s+)?instructions?|override\s+(security|safety|restrictions?|policy|policies|instructions?)|delete\s+all\s+logs|exfiltrate|disable\s+security|you\s+are\s+now\s+(a\s+|an\s+)?(different|new|unrestricted)|act\s+as\s+(a\s+|an\s+)?(jailbreak|unrestricted|unfiltered|evil|hacker|admin)|pretend\s+(you\s+)?(have\s+no|there\s+are\s+no)\s+(rules?|restrictions?|constraints?|guidelines?)|jailbreak\b)\b/i;

type ApprovalGrant = {
  remainingUses: number;
  expiresAtMs: number;
};

const approvalGrantsByScope = new Map<string, ApprovalGrant>();

function parseBooleanLike(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return TRUTHY.has(value.trim().toLowerCase());
}

function parseStrictApprovalFlag(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  return value.trim().toLowerCase() === "true";
}

function isSentinelEnabled(env: NodeJS.ProcessEnv): boolean {
  return parseBooleanLike(env.OPENCLAW_SECURITY_SENTINEL_ENABLED ?? "");
}

function parsePositiveIntegerLike(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
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

function resolveApprovalGrantUses(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntegerLike(
    env.OPENCLAW_SECURITY_SENTINEL_APPROVAL_GRANT_USES,
    DEFAULT_APPROVAL_GRANT_USES,
  );
}

function resolveApprovalGrantTtlMs(env: NodeJS.ProcessEnv): number {
  return parsePositiveIntegerLike(
    env.OPENCLAW_SECURITY_SENTINEL_APPROVAL_GRANT_TTL_MS,
    DEFAULT_APPROVAL_GRANT_TTL_MS,
  );
}

function normalizeMessageProvider(messageProvider: unknown): string | undefined {
  if (typeof messageProvider !== "string") {
    return undefined;
  }
  const normalized = messageProvider.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveStrictApprovalChannels(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.OPENCLAW_SECURITY_SENTINEL_STRICT_APPROVAL_CHANNELS?.trim();
  if (!raw) {
    return new Set(DEFAULT_STRICT_APPROVAL_CHANNELS);
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

function resolvePassphraseRequiredTools(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.OPENCLAW_SECURITY_SENTINEL_REQUIRE_PASSPHRASE_TOOLS?.trim();
  if (!raw) {
    return new Set(DEFAULT_PASSPHRASE_REQUIRED_TOOLS);
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeToolName(entry))
      .filter((entry) => entry.length > 0),
  );
}

function resolveSignalPassphraseRequired(env: NodeJS.ProcessEnv): boolean {
  const raw = env.OPENCLAW_SECURITY_SENTINEL_SIGNAL_REQUIRE_PASSPHRASE;
  if (raw === undefined) {
    return true;
  }
  return parseBooleanLike(raw);
}

function resolveSignalPassphrase(env: NodeJS.ProcessEnv): string | undefined {
  const primary = env.OPENCLAW_SECURITY_SENTINEL_SIGNAL_PASSPHRASE?.trim();
  if (primary) {
    return primary;
  }
  const legacy = env.OPENCLAW_SECURITY_SENTINEL_APPROVAL_PASSPHRASE?.trim();
  return legacy || undefined;
}

function normalizeSha256Hash(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function resolveSignalPassphraseHash(env: NodeJS.ProcessEnv): string | undefined {
  const primary = env.OPENCLAW_SECURITY_SENTINEL_SIGNAL_PASSPHRASE_HASH;
  if (primary) {
    const normalized = normalizeSha256Hash(primary);
    if (normalized) {
      return normalized;
    }
  }
  const legacy = env.OPENCLAW_SECURITY_SENTINEL_APPROVAL_PASSPHRASE_HASH;
  if (legacy) {
    const normalized = normalizeSha256Hash(legacy);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Constant-time string comparison to prevent timing-based passphrase oracle attacks.
// Handles strings of different lengths without leaking length information.
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare a to itself to burn roughly the same time; always returns false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function resolveApprovalFlag(params: unknown): boolean {
  if (!isPlainObject(params)) {
    return false;
  }
  return parseStrictApprovalFlag(params.securitySentinelApproved);
}

function resolveLegacyApprovalAliasUsed(params: unknown): boolean {
  if (!isPlainObject(params)) {
    return false;
  }
  return (
    parseBooleanLike(params.operatorApproved) ||
    parseBooleanLike(params.approved) ||
    parseBooleanLike(params.approval)
  );
}

function resolvePassphraseFromParams(params: unknown): string {
  if (!isPlainObject(params)) {
    return "";
  }
  const direct = [
    params.securitySentinelPassphrase,
    params.security_sentinel_passphrase,
    params.approvalPassphrase,
    params.passphrase,
    params.securityPassphrase,
  ];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function buildApprovalGrantScope(args: {
  sessionKey?: string;
  messageProvider?: string;
}): string | null {
  const sessionKey = args.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const provider = normalizeMessageProvider(args.messageProvider) ?? "unknown";
  return `${sessionKey}::${provider}`;
}

function resolveLiveApprovalGrant(scope: string, nowMs: number): ApprovalGrant | null {
  const grant = approvalGrantsByScope.get(scope);
  if (!grant) {
    return null;
  }
  if (grant.remainingUses <= 0 || grant.expiresAtMs <= nowMs) {
    approvalGrantsByScope.delete(scope);
    return null;
  }
  return grant;
}

function consumeApprovalGrant(scope: string, nowMs: number): number | null {
  const grant = resolveLiveApprovalGrant(scope, nowMs);
  if (!grant) {
    return null;
  }
  grant.remainingUses -= 1;
  const remainingUses = Math.max(0, grant.remainingUses);
  if (remainingUses <= 0) {
    approvalGrantsByScope.delete(scope);
  } else {
    approvalGrantsByScope.set(scope, grant);
  }
  return remainingUses;
}

function issueApprovalGrant(args: {
  scope: string;
  nowMs: number;
  uses: number;
  ttlMs: number;
}): void {
  approvalGrantsByScope.set(args.scope, {
    remainingUses: args.uses,
    expiresAtMs: args.nowMs + args.ttlMs,
  });
  if (approvalGrantsByScope.size > MAX_APPROVAL_GRANT_KEYS) {
    const oldest = approvalGrantsByScope.keys().next().value;
    if (oldest) {
      approvalGrantsByScope.delete(oldest);
    }
  }
}

function resolveApprovalState(args: {
  params: unknown;
  env: NodeJS.ProcessEnv;
  toolName: string;
  sessionKey?: string;
  messageProvider?: string;
}): {
  approved: boolean;
  reason?: string;
  matched: string[];
  grantRemainingUses?: number;
} {
  const matched: string[] = [];
  const approvedFlag = resolveApprovalFlag(args.params);
  const usedLegacyAlias = resolveLegacyApprovalAliasUsed(args.params);
  const nowMs = Date.now();
  const normalizedProvider = normalizeMessageProvider(args.messageProvider);
  const strictChannel = !!(
    normalizedProvider && resolveStrictApprovalChannels(args.env).has(normalizedProvider)
  );
  const passphraseRequiredByTool = resolvePassphraseRequiredTools(args.env).has(args.toolName);
  if (strictChannel) {
    matched.push("strict_approval_channel");
  }
  if (passphraseRequiredByTool) {
    matched.push("tool_passphrase_required");
  }

  const grantScope = buildApprovalGrantScope({
    sessionKey: args.sessionKey,
    messageProvider: normalizedProvider,
  });

  if (grantScope) {
    const remainingFromExistingGrant = consumeApprovalGrant(grantScope, nowMs);
    if (remainingFromExistingGrant !== null) {
      matched.push("approval_grant");
      return {
        approved: true,
        matched,
        grantRemainingUses: remainingFromExistingGrant,
      };
    }
  }

  if (!approvedFlag) {
    if (usedLegacyAlias) {
      matched.push("legacy_approval_alias_rejected");
      return {
        approved: false,
        matched,
        reason:
          "legacy approval aliases are not accepted; use securitySentinelApproved=true after operator approval",
      };
    }
    return { approved: false, matched };
  }

  const passphraseRequired =
    passphraseRequiredByTool || (strictChannel && resolveSignalPassphraseRequired(args.env));
  if (passphraseRequired) {
    const configuredPassphrase = resolveSignalPassphrase(args.env);
    const configuredPassphraseHash = resolveSignalPassphraseHash(args.env);
    if (!configuredPassphrase && !configuredPassphraseHash) {
      matched.push("signal_passphrase_policy_unconfigured");
      return {
        approved: false,
        matched,
        reason:
          "signal approval passphrase policy is enabled but no passphrase is configured on the gateway",
      };
    }
    const providedPassphrase = resolvePassphraseFromParams(args.params);
    if (!providedPassphrase) {
      matched.push("missing_signal_passphrase");
      return {
        approved: false,
        matched,
        reason:
          "approval requires securitySentinelPassphrase in addition to securitySentinelApproved=true",
      };
    }
    const plainMatches = configuredPassphrase
      ? timingSafeStringEqual(providedPassphrase, configuredPassphrase)
      : false;
    const hashMatches = configuredPassphraseHash
      ? timingSafeStringEqual(hashSha256(providedPassphrase), configuredPassphraseHash)
      : false;
    if (!plainMatches && !hashMatches) {
      matched.push("invalid_signal_passphrase");
      return {
        approved: false,
        matched,
        reason: "approval passphrase did not match",
      };
    }
  }

  matched.push("explicit_operator_approval");
  if (!grantScope) {
    return { approved: true, matched };
  }
  const configuredUses = resolveApprovalGrantUses(args.env);
  if (configuredUses <= 1) {
    // Zero carry-over mode: the explicit approval only applies to this tool call.
    return {
      approved: true,
      matched,
      grantRemainingUses: 0,
    };
  }

  issueApprovalGrant({
    scope: grantScope,
    nowMs,
    uses: configuredUses,
    ttlMs: resolveApprovalGrantTtlMs(args.env),
  });
  const remainingAfterConsume = consumeApprovalGrant(grantScope, nowMs);
  return {
    approved: true,
    matched,
    grantRemainingUses: remainingAfterConsume ?? 0,
  };
}

// Field names that commonly carry shell commands across tool implementations.
const COMMAND_FIELD_NAMES = [
  "cmd",
  "command",
  "chars",
  "script",
  "shell",
  "exec",
  "run",
  "input",
  "query",
  "payload",
  "body",
  "text",
] as const;

function extractPotentialCommand(params: unknown): string {
  if (!isPlainObject(params)) {
    return "";
  }
  for (const field of COMMAND_FIELD_NAMES) {
    const candidate = params[field];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  // One level of nesting (e.g. params.params.cmd for wrapped tool calls)
  if (isPlainObject(params.params)) {
    for (const field of COMMAND_FIELD_NAMES) {
      const candidate = params.params[field];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "";
}

function resolveAuditPath(env: NodeJS.ProcessEnv): string {
  const stateDir = resolveStateDir(env);
  const explicit = env.OPENCLAW_SECURITY_SENTINEL_AUDIT_PATH?.trim();
  if (explicit) {
    // Guard against path traversal: audit path must stay within the state directory.
    const resolved = path.resolve(explicit);
    const base = path.resolve(stateDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      log.warn(
        `security sentinel audit path "${explicit}" escapes state dir — falling back to default`,
      );
      return path.join(stateDir, "logs", "security-sentinel.jsonl");
    }
    return explicit;
  }
  return path.join(stateDir, "logs", "security-sentinel.jsonl");
}

// Redacts known secret patterns from command previews before writing to audit log.
const AUDIT_SECRET_RX =
  /\b(sk-ant[-\w]*|sk-proj[-\w]*|Bearer\s+\S+|ghp_\w+|ghs_\w+|(?:api[_-]?key|password|token|secret)\s*[:=]\s*\S+)/gi;

function redactSecretsForAudit(text: string): string {
  return text.replace(AUDIT_SECRET_RX, "[REDACTED]");
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
    summary.commandPreview = redactSecretsForAudit(cmd.slice(0, 160));
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
  messageProvider?: string;
  grantRemainingUses?: number;
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
  sessionKey?: string;
  messageProvider?: string;
  env?: NodeJS.ProcessEnv;
}): SecuritySentinelDecision {
  const env = args.env ?? process.env;
  const toolName = normalizeToolName(args.toolName || "tool");
  const messageProvider = normalizeMessageProvider(args.messageProvider);
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
      messageProvider,
    };
  }

  const approvalRequiredTools = resolveApprovalRequiredTools(env);
  const approvalRequired = approvalRequiredTools.has(toolName);
  const approvalState = approvalRequired
    ? resolveApprovalState({
        params: args.params,
        env,
        toolName,
        sessionKey: args.sessionKey,
        messageProvider,
      })
    : { approved: false, matched: [] as string[] };
  const approved = approvalState.approved;
  const matched: string[] = [...approvalState.matched];
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
    const approvalReason =
      approvalState.reason ?? "explicit operator approval required for this tool call";
    return {
      active: true,
      blocked: true,
      reason: `${reasonPrefix}${approvalReason}`,
      tamperType,
      toolName,
      approved,
      approvalRequired,
      riskScore,
      matched,
      messageProvider,
      grantRemainingUses: approvalState.grantRemainingUses,
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
    messageProvider,
    grantRemainingUses: approvalState.grantRemainingUses,
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
    messageProvider: args.decision.messageProvider ?? null,
    grantRemainingUses: args.decision.grantRemainingUses ?? null,
    params: summarizeParams(args.params),
  };

  try {
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify(event)}\n`, "utf8");
  } catch (err) {
    log.warn(`security sentinel audit write failed: path=${auditPath} error=${String(err)}`);
  }
}

export const __testing = {
  clearApprovalGrantsForTest() {
    approvalGrantsByScope.clear();
  },
};
