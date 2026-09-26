import { readFileSync } from "node:fs";
import { parse as parseToml, type TomlTable } from "smol-toml";
import type { CodexAppServerManagedApprovalPolicy, OpenClawExecMode } from "./config-contracts.js";
import { resolveApprovalPolicy, resolveApprovalsReviewer } from "./config-exec-policy.js";
import { readNonEmptyString, readRecord } from "./config-utils.js";
import type { CodexApprovalsReviewer, CodexSandboxMode } from "./protocol.js";

const UNIX_CODEX_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
const WINDOWS_CODEX_REQUIREMENTS_SUFFIX = "\\OpenAI\\Codex\\requirements.toml";

export function readCodexRequirementsToml(params: {
  env?: NodeJS.ProcessEnv;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
}): string | undefined {
  if (params.requirementsToml !== undefined) {
    return params.requirementsToml ?? undefined;
  }
  const requirementsPath =
    readNonEmptyString(params.requirementsPath) ??
    resolveCodexRequirementsPath(params.env ?? process.env, params.platform ?? process.platform);
  try {
    if (params.readRequirementsFile) {
      return params.readRequirementsFile(requirementsPath);
    }
    return readFileSync(requirementsPath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveCodexRequirementsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const programData = readNonEmptyString(env.ProgramData) ?? "C:\\ProgramData";
    return `${programData.replace(/[\\/]+$/, "")}${WINDOWS_CODEX_REQUIREMENTS_SUFFIX}`;
  }
  return UNIX_CODEX_REQUIREMENTS_PATH;
}

export function parseAllowedSandboxModesFromCodexRequirements(
  content: string,
  hostName: string,
): Set<CodexSandboxMode> | undefined {
  const requirements = parseCodexRequirements(content);
  const remoteSandboxModes = parseMatchingRemoteSandboxModesFromCodexRequirements(
    requirements,
    hostName,
  );
  if (remoteSandboxModes !== undefined) {
    return remoteSandboxModes;
  }
  return parseRequirementsValues(
    requirements?.allowed_sandbox_modes,
    normalizeRequirementsSandboxMode,
  );
}

export function parseAllowedApprovalPoliciesFromCodexRequirements(
  content: string,
): Set<CodexAppServerManagedApprovalPolicy> | undefined {
  return parseRequirementsValues(
    parseCodexRequirements(content)?.allowed_approval_policies,
    normalizeRequirementsApprovalPolicy,
  );
}

export function parseAllowedApprovalsReviewersFromCodexRequirements(
  content: string,
): Set<CodexApprovalsReviewer> | undefined {
  return parseRequirementsValues(
    parseCodexRequirements(content)?.allowed_approvals_reviewers,
    (value) => resolveApprovalsReviewer(value.trim().toLowerCase()),
  );
}

function parseMatchingRemoteSandboxModesFromCodexRequirements(
  requirements: TomlTable | undefined,
  hostName: string,
): Set<CodexSandboxMode> | undefined {
  const normalizedHostName = normalizeRequirementsHostName(hostName);
  const remoteConfigs = requirements?.remote_sandbox_config;
  if (normalizedHostName === undefined || !Array.isArray(remoteConfigs)) {
    return undefined;
  }
  for (const section of remoteConfigs) {
    const config = readRecord(section);
    const patterns = readRequirementsStringArray(config?.hostname_patterns);
    if (!patterns || !requirementsHostNameMatchesAnyPattern(normalizedHostName, patterns)) {
      continue;
    }
    return parseRequirementsValues(config?.allowed_sandbox_modes, normalizeRequirementsSandboxMode);
  }
  return undefined;
}

function parseRequirementsValues<T>(
  value: unknown,
  normalize: (value: string) => T | undefined,
): Set<T> | undefined {
  const values = readRequirementsStringArray(value);
  if (values === undefined) {
    return undefined;
  }
  const normalized = values.map(normalize).filter((entry): entry is T => entry !== undefined);
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function parseCodexRequirements(content: string): TomlTable | undefined {
  try {
    return parseToml(content, { integersAsBigInt: true });
  } catch {
    return undefined;
  }
}

function readRequirementsStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function normalizeRequirementsSandboxMode(value: string): CodexSandboxMode | undefined {
  const compact = value.replace(/[\s_-]/g, "").toLowerCase();
  if (compact === "readonly") {
    return "read-only";
  }
  if (compact === "workspacewrite") {
    return "workspace-write";
  }
  if (compact === "dangerfullaccess") {
    return "danger-full-access";
  }
  return undefined;
}

function normalizeRequirementsHostName(value: string): string | undefined {
  const normalized = value.trim().replace(/\.+$/g, "").toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function requirementsHostNameMatchesAnyPattern(hostName: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRequirementsHostName(pattern);
    return normalizedPattern !== undefined && globPatternMatches(hostName, normalizedPattern);
  });
}

function globPatternMatches(value: string, pattern: string): boolean {
  let regex = "^";
  for (const char of pattern) {
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  return new RegExp(regex).test(value);
}

function normalizeRequirementsApprovalPolicy(
  value: string,
): CodexAppServerManagedApprovalPolicy | undefined {
  const normalized = value.trim().toLowerCase();
  // Codex still accepts this alias in persisted requirements, while its
  // app-server exposes only the canonical on-request value.
  if (normalized === "on-failure") {
    return "on-request";
  }
  if (normalized === "untrusted") {
    return normalized;
  }
  return resolveApprovalPolicy(normalized);
}

export function selectGuardianApprovalPolicy(
  allowedApprovalPolicies: Set<CodexAppServerManagedApprovalPolicy> | undefined,
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">,
): CodexAppServerManagedApprovalPolicy {
  if (allowedApprovalPolicies === undefined || allowedApprovalPolicies.has("on-request")) {
    return "on-request";
  }
  if (allowedApprovalPolicies.has("untrusted")) {
    return "untrusted";
  }
  if (execModeRequiringPromptingApprovals) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringPromptingApprovals} requires Codex app-server prompting approvals`,
    );
  }
  if (allowedApprovalPolicies.has("never")) {
    return "never";
  }
  return "on-request";
}

export function selectGuardianApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexApprovalsReviewer> | undefined,
  execModeRequiringAutoReviewer?: Extract<OpenClawExecMode, "auto">,
): CodexApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("auto_review")) {
    return "auto_review";
  }
  if (allowedApprovalsReviewers.has("guardian_subagent")) {
    return "guardian_subagent";
  }
  if (execModeRequiringAutoReviewer) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringAutoReviewer} requires Codex app-server auto approvals`,
    );
  }
  if (allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  return "auto_review";
}

export function selectUserApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexApprovalsReviewer> | undefined,
  execModeRequiringUserReviewer?: OpenClawExecMode,
): CodexApprovalsReviewer {
  if (allowedApprovalsReviewers === undefined || allowedApprovalsReviewers.has("user")) {
    return "user";
  }
  throw new Error(
    `tools.exec.mode=${execModeRequiringUserReviewer ?? "ask"} requires Codex app-server user approvals`,
  );
}
