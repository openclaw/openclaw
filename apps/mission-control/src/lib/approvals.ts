export type ApprovalDecision =
  | "approve"
  | "approved"
  | "reject"
  | "rejected"
  | "allow-once"
  | "allow-always"
  | "allow"
  | "deny"
  | "denied"
  | string;

export interface ApprovalRecord {
  id: string;
  command: string;
  cwd?: string;
  host?: string;
  security?: string;
  ask?: string;
  agentId?: string;
  sessionKey?: string;
  resolvedPath?: string;
  timestamp?: string;
  createdAt?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  status?: string;
  decision?: string;
  resolvedBy?: string;
  resolvedAtMs?: number;
  raw?: unknown;
}

type UnknownRecord = Record<string, unknown>;

const WRAPPER_TOKENS = new Set(["sudo", "env", "command", "time", "nohup"]);
const APPROVED_DECISIONS = new Set([
  "approve",
  "approved",
  "allow",
  "allow-once",
  "allow-always",
  "granted",
]);
const REJECTED_DECISIONS = new Set(["reject", "rejected", "deny", "denied", "blocked", "block"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {continue;}
    const trimmed = value.trim();
    if (trimmed) {return trimmed;}
  }
  return undefined;
}

function parseDateMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value < 10_000_000_000) {return Math.floor(value * 1000);}
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {return undefined;}
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      if (numeric < 10_000_000_000) {return Math.floor(numeric * 1000);}
      return Math.floor(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {return parsed;}
  }
  return undefined;
}

function toIsoIfValid(ms?: number, fallback?: string): string | undefined {
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function stableHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function mergeRecord(existing: ApprovalRecord, incoming: ApprovalRecord): ApprovalRecord {
  return {
    ...existing,
    ...incoming,
    id: incoming.id || existing.id,
    command: incoming.command || existing.command,
    createdAtMs: Math.max(existing.createdAtMs ?? 0, incoming.createdAtMs ?? 0) || undefined,
    resolvedAtMs: Math.max(existing.resolvedAtMs ?? 0, incoming.resolvedAtMs ?? 0) || undefined,
    timestamp: incoming.timestamp || existing.timestamp,
    createdAt: incoming.createdAt || existing.createdAt,
    raw: incoming.raw ?? existing.raw,
  };
}

function parseApprovalCandidate(candidate: unknown, index: number): ApprovalRecord | null {
  if (!isRecord(candidate)) {return null;}

  const request = isRecord(candidate.request) ? candidate.request : undefined;
  const command = firstNonEmptyString([
    candidate.command,
    candidate.cmd,
    request?.command,
  ]);
  if (!command) {return null;}

  const createdAtMs = parseDateMs(
    candidate.createdAtMs ??
      candidate.createdMs ??
      candidate.ts ??
      candidate.timestamp ??
      candidate.createdAt ??
      request?.createdAtMs
  );
  const expiresAtMs = parseDateMs(
    candidate.expiresAtMs ??
      candidate.expiresMs ??
      candidate.expiresAt ??
      request?.expiresAtMs
  );
  const resolvedAtMs = parseDateMs(
    candidate.resolvedAtMs ??
      candidate.resolvedAt ??
      candidate.resolvedTs ??
      candidate.updatedAtMs
  );

  const createdText = firstNonEmptyString([
    candidate.timestamp,
    candidate.createdAt,
    request?.timestamp,
    request?.createdAt,
  ]);
  const idBase = firstNonEmptyString([candidate.id, request?.id]);
  const fallbackId = `approval-${stableHash(`${command}|${createdAtMs ?? createdText ?? index}`)}`;

  return {
    id: idBase ?? fallbackId,
    command,
    cwd: firstNonEmptyString([candidate.cwd, request?.cwd]),
    host: firstNonEmptyString([candidate.host, request?.host]),
    security: firstNonEmptyString([candidate.security, request?.security]),
    ask: firstNonEmptyString([candidate.ask, request?.ask]),
    agentId: firstNonEmptyString([candidate.agentId, candidate.agent, request?.agentId]),
    sessionKey: firstNonEmptyString([
      candidate.sessionKey,
      candidate.session,
      request?.sessionKey,
    ]),
    resolvedPath: firstNonEmptyString([candidate.resolvedPath, request?.resolvedPath]),
    status: firstNonEmptyString([candidate.status]),
    decision: firstNonEmptyString([candidate.decision]),
    resolvedBy: firstNonEmptyString([candidate.resolvedBy]),
    createdAtMs,
    expiresAtMs,
    resolvedAtMs,
    timestamp: toIsoIfValid(createdAtMs, createdText),
    createdAt: toIsoIfValid(createdAtMs, createdText),
    raw: candidate,
  };
}

function collectObjectValues(input: unknown): unknown[] {
  if (!isRecord(input)) {return [];}
  const values: unknown[] = [];
  for (const value of Object.values(input)) {
    if (Array.isArray(value)) {values.push(...value);}
    else if (isRecord(value)) {values.push(value);}
  }
  return values;
}

export function looksLikeApprovalsConfigSnapshot(input: unknown): boolean {
  if (!isRecord(input)) {return false;}
  return (
    ("file" in input && "hash" in input) ||
    ("exists" in input && "path" in input) ||
    ("socket" in input && "agents" in input)
  );
}

export function extractApprovalCandidates(input: unknown): unknown[] {
  if (!input) {return [];}
  if (Array.isArray(input)) {return input;}
  if (!isRecord(input)) {return [];}

  const nestedKeys = ["approvals", "pending", "requests", "queue", "items", "entries"];
  for (const key of nestedKeys) {
    if (!(key in input)) {continue;}
    const nested = input[key];
    const extracted = extractApprovalCandidates(nested);
    if (extracted.length > 0) {return extracted;}
  }

  const directCommand = firstNonEmptyString([
    input.command,
    input.cmd,
    isRecord(input.request) ? input.request.command : undefined,
  ]);
  if (directCommand) {return [input];}

  return collectObjectValues(input);
}

export function normalizeApprovalRecords(input: unknown): ApprovalRecord[] {
  const candidates = extractApprovalCandidates(input);
  if (candidates.length === 0) {return [];}

  const byId = new Map<string, ApprovalRecord>();
  for (let i = 0; i < candidates.length; i += 1) {
    const parsed = parseApprovalCandidate(candidates[i], i);
    if (!parsed) {continue;}
    const existing = byId.get(parsed.id);
    byId.set(parsed.id, existing ? mergeRecord(existing, parsed) : parsed);
  }
  return [...byId.values()];
}

export function isApprovalApproved(value?: string | null): boolean {
  if (!value) {return false;}
  return APPROVED_DECISIONS.has(value.trim().toLowerCase());
}

export function isApprovalRejected(value?: string | null): boolean {
  if (!value) {return false;}
  return REJECTED_DECISIONS.has(value.trim().toLowerCase());
}

export function isApprovalResolved(approval: ApprovalRecord): boolean {
  if (isApprovalApproved(approval.decision) || isApprovalRejected(approval.decision)) {return true;}
  const status = approval.status?.trim().toLowerCase();
  if (!status) {return false;}
  if (status.includes("pending") || status.includes("queued") || status.includes("waiting")) {
    return false;
  }
  return (
    status.includes("resolved") ||
    status.includes("approved") ||
    status.includes("rejected") ||
    status.includes("deny")
  );
}

export function approvalCreatedMs(approval: ApprovalRecord): number {
  return parseDateMs(approval.createdAtMs ?? approval.timestamp ?? approval.createdAt) ?? 0;
}

export function approvalResolvedMs(approval: ApprovalRecord): number {
  return (
    parseDateMs(
      approval.resolvedAtMs ??
        approval.timestamp ??
        approval.createdAt ??
        approval.createdAtMs
    ) ?? 0
  );
}

export function approvalDecisionLabel(approval: ApprovalRecord): string {
  const value = (approval.decision || approval.status || "").trim().toLowerCase();
  if (!value) {return "Pending";}
  if (value === "allow-once") {return "Approved (Once)";}
  if (value === "allow-always") {return "Approved (Always)";}
  if (isApprovalApproved(value)) {return "Approved";}
  if (isApprovalRejected(value)) {return "Rejected";}
  if (value.includes("resolved")) {return "Resolved";}
  return value.replace(/-/g, " ");
}

export function primaryCommand(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {return "unknown";}
  const tokens = normalized.split(" ");
  let cursor = 0;

  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[cursor])) {
    cursor += 1;
  }
  while (cursor < tokens.length && WRAPPER_TOKENS.has(tokens[cursor])) {
    cursor += 1;
  }
  if (cursor >= tokens.length) {return tokens[0];}

  return tokens[cursor].replace(/^['"]|['"]$/g, "");
}

interface RiskRule {
  id: string;
  label: string;
  weight: number;
  consequence: string;
  patterns: RegExp[];
}

export type ApprovalRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ApprovalRiskAssessment {
  level: ApprovalRiskLevel;
  score: number;
  summary: string;
  consequences: string[];
  signals: string[];
  primaryCommand: string;
  stepCount: number;
  requiresStepUp: boolean;
}

const RISK_RULES: RiskRule[] = [
  {
    id: "remote-exec",
    label: "Remote code execution",
    weight: 55,
    consequence: "Can download and execute untrusted code directly on your host.",
    patterns: [/\bcurl\b[^|]*\|\s*(bash|sh)\b/i, /\bwget\b[^|]*\|\s*(bash|sh)\b/i],
  },
  {
    id: "destructive-delete",
    label: "Destructive file operations",
    weight: 48,
    consequence: "Can permanently delete files or directories.",
    patterns: [/\brm\s+-rf\b/i, /\brm\s+-r\b/i, /\brmdir\b/i, /\bdel\s+\/[sqf]/i],
  },
  {
    id: "filesystem-format",
    label: "Disk or filesystem formatting",
    weight: 65,
    consequence: "Can irreversibly wipe storage volumes.",
    patterns: [/\bmkfs\b/i, /\bformat\b/i],
  },
  {
    id: "database-destruction",
    label: "Database destructive commands",
    weight: 45,
    consequence: "Can remove or overwrite database records.",
    patterns: [/\bdrop\s+table\b/i, /\btruncate\s+table\b/i, /\bdrop\s+database\b/i],
  },
  {
    id: "privilege-change",
    label: "Privilege or permission changes",
    weight: 32,
    consequence: "Can expand access scope or weaken security boundaries.",
    patterns: [/\bsudo\b/i, /\bchmod\b/i, /\bchown\b/i, /\busermod\b/i],
  },
  {
    id: "package-install",
    label: "Environment dependency changes",
    weight: 22,
    consequence: "Can alter runtime behavior and introduce unvetted dependencies.",
    patterns: [
      /\b(npm|pnpm|yarn)\s+(install|add|update|upgrade)\b/i,
      /\bpip\s+(install|uninstall)\b/i,
      /\bapt(-get)?\s+(install|remove|upgrade)\b/i,
      /\bbrew\s+(install|upgrade|remove)\b/i,
    ],
  },
  {
    id: "network-egress",
    label: "Network data transfer",
    weight: 18,
    consequence: "Can send or receive data over external networks.",
    patterns: [/\bcurl\b/i, /\bwget\b/i, /\bscp\b/i, /\brsync\b/i, /\bssh\b/i],
  },
  {
    id: "process-control",
    label: "Process/service control",
    weight: 18,
    consequence: "Can stop services or disrupt running workloads.",
    patterns: [/\bkill(all)?\b/i, /\bpkill\b/i, /\bsystemctl\b/i, /\blaunchctl\b/i],
  },
  {
    id: "git-history",
    label: "Git history rewrite",
    weight: 28,
    consequence: "Can rewrite commit history or discard local code changes.",
    patterns: [/\bgit\s+push\s+--force\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-fd/i],
  },
];

function buildRiskSummary(level: ApprovalRiskLevel, signals: string[]): string {
  if (level === "CRITICAL") {
    return "Critical impact expected. This command can cause irreversible or high-blast-radius changes.";
  }
  if (level === "HIGH") {
    return "High impact expected. Review command intent and execution context before approval.";
  }
  if (level === "MEDIUM") {
    return "Moderate impact expected. This command changes project or environment state.";
  }
  if (signals.length > 0) {
    return "Low direct impact detected, but execution is still a state-changing operation.";
  }
  return "Low apparent impact. Continue only if command intent matches your requested task.";
}

export function assessApprovalRisk(command: string): ApprovalRiskAssessment {
  const normalized = command.trim();
  const lower = normalized.toLowerCase();
  const matchedRules = RISK_RULES.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(lower))
  );
  const signals = matchedRules.map((rule) => rule.label);
  const consequences = matchedRules.map((rule) => rule.consequence);

  const chainSegments = normalized
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const stepCount = Math.max(chainSegments.length, 1);
  const hasPipeline = /\|/.test(normalized);

  let score = 6;
  for (const rule of matchedRules) {score += rule.weight;}
  if (stepCount >= 2) {score += 6;}
  if (stepCount >= 4) {score += 8;}
  if (hasPipeline) {score += 4;}
  if (normalized.length > 180) {score += 4;}
  score = Math.min(score, 99);

  const level: ApprovalRiskLevel =
    score >= 80 ? "CRITICAL" : score >= 55 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
  if (stepCount > 1) {
    consequences.push(`Runs ${stepCount} chained command steps; each step can increase blast radius.`);
  }
  if (consequences.length === 0) {
    consequences.push("Runs a shell command on the target host and may change local state.");
  }

  return {
    level,
    score,
    summary: buildRiskSummary(level, signals),
    consequences: Array.from(new Set(consequences)),
    signals,
    primaryCommand: primaryCommand(normalized),
    stepCount,
    requiresStepUp: level === "HIGH" || level === "CRITICAL",
  };
}

function firstCommandToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {return null;}
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const raw = match ? match[1] || match[2] || match[3] : null;
  return raw?.trim() || null;
}

/**
 * Build a best-effort allowlist pattern for "always allow" actions.
 * Prefers gateway-resolved executable paths and falls back to command tokens.
 */
export function suggestAllowlistPattern(approval: ApprovalRecord): string | null {
  const resolvedPath = approval.resolvedPath?.trim();
  if (resolvedPath) {return resolvedPath;}

  const token = firstCommandToken(approval.command);
  if (!token) {return null;}

  if (token.startsWith("~") || token.startsWith("/")) {return token;}
  const looksLikePath = token.includes("/") || token.includes("\\");
  if (!looksLikePath) {return null;}

  const cwd = approval.cwd?.trim();
  if (!cwd) {return token;}
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (token.startsWith("./")) {return `${base}/${token.slice(2)}`;}
  return `${base}/${token}`;
}

export interface AllowlistPatternSuggestion {
  label: string;
  value: string;
  description: string;
}

export type AllowlistPatternScope = "invalid" | "exact" | "narrow" | "broad" | "very-broad";

export interface AllowlistPatternPreview {
  normalizedPattern: string;
  isValid: boolean;
  scope: AllowlistPatternScope;
  scopeLabel: string;
  scopeDescription: string;
  wildcardCount: number;
  matchesTarget: boolean | null;
  matchSummary: string;
}

function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += ".";
      i += 1;
      continue;
    }
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  regex += "$";
  return new RegExp(regex, "i");
}

function firstHomePrefix(value: string | undefined): string | null {
  if (!value) {return null;}
  const normalized = value.replace(/\\/g, "/");
  const userMatch = normalized.match(/^\/Users\/[^/]+/);
  if (userMatch?.[0]) {return userMatch[0];}
  const homeMatch = normalized.match(/^\/home\/[^/]+/);
  if (homeMatch?.[0]) {return homeMatch[0];}
  return null;
}

function resolvePatternHome(pattern: string, cwd?: string): string {
  if (!pattern.startsWith("~")) {return pattern;}
  const homePrefix = firstHomePrefix(cwd);
  if (!homePrefix) {return pattern;}
  if (pattern === "~") {return homePrefix;}
  if (pattern.startsWith("~/")) {return `${homePrefix}/${pattern.slice(2)}`;}
  return pattern;
}

function parentDir(pathLike: string): string | null {
  const normalized = pathLike.replace(/\\/g, "/");
  const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {return null;}
  return trimmed.slice(0, idx);
}

function wildcardCount(pattern: string): number {
  const stars = (pattern.match(/\*/g) ?? []).length;
  const qmarks = (pattern.match(/\?/g) ?? []).length;
  return stars + qmarks;
}

export function isPathLikeAllowlistPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {return false;}
  return trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("~");
}

export function matchesAllowlistPattern(params: {
  pattern: string;
  targetPath?: string;
  cwd?: string;
}): boolean | null {
  const trimmed = params.pattern.trim();
  if (!trimmed || !isPathLikeAllowlistPattern(trimmed)) {return null;}
  const targetPath = params.targetPath?.trim();
  if (!targetPath) {return null;}
  const normalizedPattern = normalizeForMatch(resolvePatternHome(trimmed, params.cwd));
  const normalizedTarget = normalizeForMatch(targetPath);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedTarget);
}

function classifyPatternScope(pattern: string): AllowlistPatternScope {
  if (!isPathLikeAllowlistPattern(pattern)) {return "invalid";}
  const wc = wildcardCount(pattern);
  if (wc === 0) {return "exact";}
  if (wc === 1 && pattern.endsWith('/*') && !pattern.includes("**")) {return "narrow";}
  if (pattern.includes("**") || wc >= 3 || /^~?\/\*\*?$/.test(pattern)) {return "very-broad";}
  return "broad";
}

function scopeMeta(scope: AllowlistPatternScope): {
  label: string;
  description: string;
} {
  if (scope === "exact") {
    return {
      label: "Exact",
      description: "Matches one executable path only.",
    };
  }
  if (scope === "narrow") {
    return {
      label: "Narrow wildcard",
      description: "Matches files in one directory level.",
    };
  }
  if (scope === "broad") {
    return {
      label: "Broad wildcard",
      description: "Matches multiple executable paths. Review blast radius.",
    };
  }
  if (scope === "very-broad") {
    return {
      label: "Very broad",
      description: "High blast radius. This can allow many executables.",
    };
  }
  return {
    label: "Invalid",
    description: "Pattern must include a path separator or ~ to match executable paths.",
  };
}

export function previewAllowlistPattern(params: {
  pattern: string;
  targetPath?: string;
  cwd?: string;
}): AllowlistPatternPreview {
  const normalizedPattern = params.pattern.trim();
  const scope = classifyPatternScope(normalizedPattern);
  const meta = scopeMeta(scope);
  const matchesTarget =
    scope === "invalid"
      ? null
      : matchesAllowlistPattern({
          pattern: normalizedPattern,
          targetPath: params.targetPath,
          cwd: params.cwd,
        });

  let matchSummary = "No executable path available for preview.";
  if (matchesTarget === true) {matchSummary = "Pattern matches the current executable path.";}
  if (matchesTarget === false) {matchSummary = "Pattern does not match the current executable path.";}
  if (!params.targetPath && scope !== "invalid") {
    matchSummary = "Current executable path is unavailable; preview is limited.";
  }
  if (normalizedPattern.startsWith("~") && !firstHomePrefix(params.cwd)) {
    matchSummary = "Pattern uses ~; preview may be incomplete without a known home path.";
  }

  return {
    normalizedPattern,
    isValid: scope !== "invalid",
    scope,
    scopeLabel: meta.label,
    scopeDescription: meta.description,
    wildcardCount: wildcardCount(normalizedPattern),
    matchesTarget,
    matchSummary,
  };
}

export function buildAllowlistPatternSuggestions(
  approval: ApprovalRecord
): AllowlistPatternSuggestion[] {
  const base = suggestAllowlistPattern(approval);
  if (!base) {return [];}
  const normalized = base.replace(/\\/g, "/");
  const suggestions: AllowlistPatternSuggestion[] = [
    {
      label: "Exact executable",
      value: normalized,
      description: "Allow this exact resolved executable only.",
    },
  ];
  const dir = parentDir(normalized);
  if (dir) {
    suggestions.push({
      label: "Directory wildcard",
      value: `${dir}/*`,
      description: "Allow executables in this directory.",
    });
    suggestions.push({
      label: "Recursive directory",
      value: `${dir}/**`,
      description: "Allow executables in this directory tree.",
    });
  }

  const seen = new Set<string>();
  return suggestions.filter((item) => {
    if (!item.value.trim() || seen.has(item.value)) {return false;}
    seen.add(item.value);
    return true;
  });
}
