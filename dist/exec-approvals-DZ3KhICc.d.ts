import { V as SafeBinProfile } from "./types.tools-BpgZArJS.js";

//#region src/infra/exec-approvals.types.d.ts
type ExecAllowlistEntry = {
  id?: string;
  pattern: string;
  source?: "allow-always";
  commandText?: string;
  argPattern?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};
//#endregion
//#region src/infra/exec-command-resolution.d.ts
type ExecutableResolution = {
  rawExecutable: string;
  resolvedPath?: string;
  resolvedRealPath?: string;
  executableName: string;
};
type CommandResolution = {
  execution: ExecutableResolution;
  policy: ExecutableResolution;
  effectiveArgv?: string[];
  wrapperChain?: string[];
  policyBlocked?: boolean;
  blockedWrapper?: string;
};
declare function resolveCommandResolution(command: string, cwd?: string, env?: NodeJS.ProcessEnv): CommandResolution | null;
declare function resolveCommandResolutionFromArgv(argv: string[], cwd?: string, env?: NodeJS.ProcessEnv): CommandResolution | null;
declare function resolveExecutableTrustPath(resolution: ExecutableResolution | null | undefined, cwd?: string): string | undefined;
declare function resolveExecutionTargetResolution(resolution: CommandResolution | ExecutableResolution | null): ExecutableResolution | null;
declare function resolvePolicyTargetResolution(resolution: CommandResolution | ExecutableResolution | null): ExecutableResolution | null;
declare function resolveExecutionTargetCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
declare function resolveExecutionTargetTrustPath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
declare function resolvePolicyTargetCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
declare function resolvePolicyTargetTrustPath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
declare function resolveApprovalAuditCandidatePath(resolution: CommandResolution | null, cwd?: string): string | undefined;
declare function resolveApprovalAuditTrustPath(resolution: CommandResolution | null, cwd?: string): string | undefined;
/** @deprecated Use resolveExecutionTargetCandidatePath. */
declare function resolveAllowlistCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
declare function resolvePolicyAllowlistCandidatePath(resolution: CommandResolution | ExecutableResolution | null, cwd?: string): string | undefined;
declare function matchAllowlist(entries: ExecAllowlistEntry[], resolution: ExecutableResolution | null, argv?: string[], platform?: string | null): ExecAllowlistEntry | null;
type ExecArgvToken = {
  kind: "empty";
  raw: string;
} | {
  kind: "terminator";
  raw: string;
} | {
  kind: "stdin";
  raw: string;
} | {
  kind: "positional";
  raw: string;
} | {
  kind: "option";
  raw: string;
  style: "long";
  flag: string;
  inlineValue?: string;
} | {
  kind: "option";
  raw: string;
  style: "short-cluster";
  cluster: string;
  flags: string[];
};
/**
 * Tokenizes a single argv entry into a normalized option/positional model.
 * Consumers can share this model to keep argv parsing behavior consistent.
 */
declare function parseExecArgvToken(raw: string): ExecArgvToken;
//#endregion
//#region src/infra/exec-approvals-analysis.d.ts
type ExecCommandSegment = {
  raw: string;
  argv: string[];
  sourceArgv?: string[];
  resolution: CommandResolution | null;
};
type ExecCommandAnalysis = {
  ok: boolean;
  reason?: string;
  segments: ExecCommandSegment[];
  chains?: ExecCommandSegment[][];
};
type ShellChainOperator = "&&" | "||" | ";";
type ShellChainPart = {
  part: string;
  opToNext: ShellChainOperator | null;
};
declare function isWindowsPlatform(platform?: string | null): boolean;
/**
 * Splits a command string by chain operators (&&, ||, ;) while preserving the operators.
 * Returns null when no chain is present or when the chain is malformed.
 */
declare function splitCommandChainWithOperators(command: string): ShellChainPart[] | null;
declare function windowsEscapeArg(value: string): {
  ok: true;
  escaped: string;
} | {
  ok: false;
};
/**
 * Builds a shell command string that preserves pipes/chaining, but forces *arguments* to be
 * literal (no globbing, no env-var expansion) by single-quoting every argv token.
 *
 * Used to make "safe bins" actually stdin-only even though execution happens via `shell -c`.
 */
declare function buildSafeShellCommand(params: {
  command: string;
  platform?: string | null;
}): {
  ok: boolean;
  command?: string;
  reason?: string;
};
declare function resolvePlannedSegmentArgv(segment: ExecCommandSegment): string[] | null;
/**
 * Rebuilds a shell command and selectively single-quotes argv tokens for segments that
 * must be treated as literal (safeBins hardening) while preserving the rest of the
 * shell syntax (pipes + chaining).
 */
declare function buildSafeBinsShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ("allowlist" | "safeBins" | "inlineChain" | "skills" | null)[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): {
  ok: boolean;
  command?: string;
  reason?: string;
};
declare function buildEnforcedShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  platform?: string | null;
}): {
  ok: boolean;
  command?: string;
  reason?: string;
};
/**
 * Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
 * Returns null when no chain is present or when the chain is malformed.
 */
declare function splitCommandChain(command: string): string[] | null;
declare function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ExecCommandAnalysis;
declare function analyzeArgvCommand(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis;
//#endregion
//#region src/infra/command-analysis/explain.d.ts
type CommandExplanationSummary = {
  commandCount: number;
  nestedCommandCount: number;
  riskKinds: string[];
  warningLines: string[];
};
//#endregion
//#region src/infra/exec-safe-bin-trust.d.ts
type TrustedSafeBinPathParams = {
  resolvedPath: string;
  trustedDirs?: ReadonlySet<string>;
};
declare function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): boolean;
//#endregion
//#region src/infra/exec-approvals-allowlist.d.ts
declare function normalizeSafeBins(entries?: readonly string[]): Set<string>;
declare function resolveSafeBins(entries?: readonly string[] | null): Set<string>;
declare function isSafeBinUsage(params: {
  argv: string[];
  resolution: ExecutableResolution | null;
  safeBins: Set<string>;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  isTrustedSafeBinPathFn?: typeof isTrustedSafeBinPath;
}): boolean;
type ExecAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};
type ExecSegmentSatisfiedBy = "allowlist" | "safeBins" | "inlineChain" | "skills" | null;
type SkillBinTrustEntry = {
  name: string;
  resolvedPath: string;
};
type ExecAllowlistContext = {
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: readonly SkillBinTrustEntry[];
  autoAllowSkills?: boolean;
};
declare function evaluateExecAllowlist(params: {
  analysis: ExecCommandAnalysis;
} & ExecAllowlistContext): ExecAllowlistEvaluation;
type ExecAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};
type AllowAlwaysPattern = {
  pattern: string;
  argPattern?: string;
};
/**
 * Derive persisted allowlist patterns for an "allow always" decision.
 * When a command is wrapped in a shell (for example `zsh -lc "<cmd>"`),
 * persist the inner executable(s) rather than the shell binary.
 */
declare function resolveAllowAlwaysPatternEntries(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): AllowAlwaysPattern[];
declare function resolveAllowAlwaysPatterns(params: {
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): string[];
/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
declare function evaluateShellAllowlist(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
} & ExecAllowlistContext): ExecAllowlistAnalysis;
//#endregion
//#region src/infra/exec-approvals.d.ts
type ExecHost = "sandbox" | "gateway" | "node";
type ExecTarget = "auto" | ExecHost;
type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";
declare const EXEC_TARGET_VALUES: readonly ExecTarget[];
declare function normalizeExecHost(value?: string | null): ExecHost | null;
declare function normalizeExecTarget(value?: string | null): ExecTarget | null;
declare function requireValidExecTarget(value?: unknown): ExecTarget | null;
declare function normalizeExecSecurity(value?: string | null): ExecSecurity | null;
declare function normalizeExecAsk(value?: string | null): ExecAsk | null;
type SystemRunApprovalBinding = {
  argv: string[];
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  envHash: string | null;
};
type SystemRunApprovalFileOperand = {
  argvIndex: number;
  path: string;
  sha256: string;
};
type SystemRunApprovalPlan = {
  argv: string[];
  cwd: string | null;
  commandText: string;
  commandPreview?: string | null;
  agentId: string | null;
  sessionKey: string | null;
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
};
type ExecApprovalCommandSpan = {
  startIndex: number;
  endIndex: number;
};
type ExecApprovalRequestPayload = {
  command: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandSpans?: ExecApprovalCommandSpan[];
  allowedDecisions?: readonly ExecApprovalDecision[];
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};
type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};
type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: ExecApprovalRequest["request"];
};
type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};
type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecAllowlistEntry[];
};
type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};
type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  file: ExecApprovalsFile;
  hash: string;
};
type ExecApprovalsResolved = {
  path: string;
  socketPath: string;
  token: string;
  defaults: Required<ExecApprovalsDefaults>;
  agent: Required<ExecApprovalsDefaults>;
  agentSources: {
    security: string | null;
    ask: string | null;
    askFallback: string | null;
  };
  allowlist: ExecAllowlistEntry[];
  file: ExecApprovalsFile;
};
declare const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1800000;
declare const DEFAULT_EXEC_APPROVAL_ASK_FALLBACK: ExecSecurity;
declare function resolveExecApprovalsPath(): string;
declare function resolveExecApprovalsSocketPath(): string;
declare function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile;
declare function mergeExecApprovalsSocketDefaults(params: {
  normalized: ExecApprovalsFile;
  current?: ExecApprovalsFile;
}): ExecApprovalsFile;
declare function readExecApprovalsSnapshot(): ExecApprovalsSnapshot;
declare function loadExecApprovals(): ExecApprovalsFile;
declare function saveExecApprovals(file: ExecApprovalsFile): void;
declare function restoreExecApprovalsSnapshot(snapshot: ExecApprovalsSnapshot): void;
declare function ensureExecApprovals(): ExecApprovalsFile;
type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};
declare function resolveExecApprovals(agentId?: string, overrides?: ExecApprovalsDefaultOverrides): ExecApprovalsResolved;
declare function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved;
declare function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean;
declare function hasDurableExecApproval(params: {
  analysisOk: boolean;
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  allowlist?: readonly ExecAllowlistEntry[];
  commandText?: string | null;
}): boolean;
declare function recordAllowlistUse(approvals: ExecApprovalsFile, agentId: string | undefined, entry: ExecAllowlistEntry, command: string, resolvedPath?: string): void;
declare function recordAllowlistMatchesUse(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  matches: readonly ExecAllowlistEntry[];
  command: string;
  resolvedPath?: string;
}): void;
declare function addAllowlistEntry(approvals: ExecApprovalsFile, agentId: string | undefined, pattern: string, options?: {
  argPattern?: string;
  source?: ExecAllowlistEntry["source"];
}): void;
declare function addDurableCommandApproval(approvals: ExecApprovalsFile, agentId: string | undefined, commandText: string): void;
declare function persistAllowAlwaysPatterns(params: {
  approvals: ExecApprovalsFile;
  agentId: string | undefined;
  segments: ExecCommandSegment[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  strictInlineEval?: boolean;
}): ReturnType<typeof resolveAllowAlwaysPatternEntries>;
declare function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity;
declare function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk;
type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
declare const DEFAULT_EXEC_APPROVAL_DECISIONS: readonly ["allow-once", "allow-always", "deny"];
declare function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
}): readonly ExecApprovalDecision[];
declare function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[];
declare function isExecApprovalDecisionAllowed(params: {
  decision: ExecApprovalDecision;
  ask?: string | null;
}): boolean;
declare function requestExecApprovalViaSocket(params: {
  socketPath: string;
  token: string;
  request: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<ExecApprovalDecision | null>;
//#endregion
export { ExecAllowlistAnalysis as $, mergeExecApprovalsSocketDefaults as A, resolveAllowlistCandidatePath as At, recordAllowlistUse as B, resolvePolicyTargetCandidatePath as Bt, addAllowlistEntry as C, splitCommandChainWithOperators as Ct, isExecApprovalDecisionAllowed as D, ExecutableResolution as Dt, hasDurableExecApproval as E, ExecArgvToken as Et, normalizeExecSecurity as F, resolveExecutableTrustPath as Ft, resolveExecApprovalRequestAllowedDecisions as G, requireValidExecTarget as H, resolvePolicyTargetTrustPath as Ht, normalizeExecTarget as I, resolveExecutionTargetCandidatePath as It, resolveExecApprovalsPath as J, resolveExecApprovals as K, persistAllowAlwaysPatterns as L, resolveExecutionTargetResolution as Lt, normalizeExecApprovals as M, resolveApprovalAuditTrustPath as Mt, normalizeExecAsk as N, resolveCommandResolution as Nt, loadExecApprovals as O, matchAllowlist as Ot, normalizeExecHost as P, resolveCommandResolutionFromArgv as Pt, AllowAlwaysPattern as Q, readExecApprovalsSnapshot as R, resolveExecutionTargetTrustPath as Rt, SystemRunApprovalPlan as S, splitCommandChain as St, ensureExecApprovals as T, CommandResolution as Tt, requiresExecApproval as U, ExecAllowlistEntry as Ut, requestExecApprovalViaSocket as V, resolvePolicyTargetResolution as Vt, resolveExecApprovalAllowedDecisions as W, restoreExecApprovalsSnapshot as X, resolveExecApprovalsSocketPath as Y, saveExecApprovals as Z, ExecHost as _, buildEnforcedShellCommand as _t, ExecApprovalCommandSpan as a, isSafeBinUsage as at, SystemRunApprovalBinding as b, isWindowsPlatform as bt, ExecApprovalRequestPayload as c, resolveAllowAlwaysPatterns as ct, ExecApprovalsDefaultOverrides as d, ExecCommandAnalysis as dt, ExecAllowlistEvaluation as et, ExecApprovalsDefaults as f, ExecCommandSegment as ft, ExecAsk as g, analyzeShellCommand as gt, ExecApprovalsSnapshot as h, analyzeArgvCommand as ht, EXEC_TARGET_VALUES as i, evaluateShellAllowlist as it, minSecurity as j, resolveApprovalAuditCandidatePath as jt, maxAsk as k, parseExecArgvToken as kt, ExecApprovalResolved as l, resolveSafeBins as lt, ExecApprovalsResolved as m, ShellChainPart as mt, DEFAULT_EXEC_APPROVAL_DECISIONS as n, SkillBinTrustEntry as nt, ExecApprovalDecision as o, normalizeSafeBins as ot, ExecApprovalsFile as p, ShellChainOperator as pt, resolveExecApprovalsFromFile as q, DEFAULT_EXEC_APPROVAL_TIMEOUT_MS as r, evaluateExecAllowlist as rt, ExecApprovalRequest as s, resolveAllowAlwaysPatternEntries as st, DEFAULT_EXEC_APPROVAL_ASK_FALLBACK as t, ExecSegmentSatisfiedBy as tt, ExecApprovalsAgent as u, CommandExplanationSummary as ut, ExecSecurity as v, buildSafeBinsShellCommand as vt, addDurableCommandApproval as w, windowsEscapeArg as wt, SystemRunApprovalFileOperand as x, resolvePlannedSegmentArgv as xt, ExecTarget as y, buildSafeShellCommand as yt, recordAllowlistMatchesUse as z, resolvePolicyAllowlistCandidatePath as zt };