import { readFileSync } from "node:fs";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
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

export function parseCodexRequirementsPolicy(content: string | undefined, hostName = "") {
  const requirements = content === undefined ? undefined : parseCodexRequirements(content);
  return {
    allowedSandboxModes:
      parseMatchingRemoteSandboxModesFromCodexRequirements(requirements, hostName) ??
      parseRequirementsValues(
        requirements?.allowed_sandbox_modes,
        normalizeRequirementsSandboxMode,
      ),
    allowedApprovalPolicies: parseRequirementsValues(
      requirements?.allowed_approval_policies,
      normalizeRequirementsApprovalPolicy,
    ),
    allowedApprovalsReviewers: parseRequirementsValues(
      requirements?.allowed_approvals_reviewers,
      (value) => resolveApprovalsReviewer(value.trim().toLowerCase()),
    ),
  };
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
  return (["read-only", "workspace-write", "danger-full-access"] as const).find(
    (mode) => mode.replaceAll("-", "") === compact,
  );
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
  const regex = escapeRegExp(pattern).replaceAll("\\*", ".*").replaceAll("\\?", ".");
  return new RegExp(`^${regex}$`).test(value);
}

function normalizeRequirementsApprovalPolicy(
  value: string,
): CodexAppServerManagedApprovalPolicy | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "untrusted") {
    return normalized;
  }
  return resolveApprovalPolicy(normalized);
}

export function selectGuardianApprovalPolicy(
  allowedApprovalPolicies: Set<CodexAppServerManagedApprovalPolicy> | undefined,
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">,
): CodexAppServerManagedApprovalPolicy {
  return selectManagedPolicy(
    allowedApprovalPolicies,
    ["on-request", "untrusted", "never"],
    execModeRequiringPromptingApprovals &&
      `tools.exec.mode=${execModeRequiringPromptingApprovals} requires Codex app-server prompting approvals`,
  );
}

export function selectGuardianApprovalsReviewer(
  allowedApprovalsReviewers: Set<CodexApprovalsReviewer> | undefined,
  execModeRequiringAutoReviewer?: Extract<OpenClawExecMode, "auto">,
): CodexApprovalsReviewer {
  return selectManagedPolicy(
    allowedApprovalsReviewers,
    ["auto_review", "guardian_subagent", "user"],
    execModeRequiringAutoReviewer &&
      `tools.exec.mode=${execModeRequiringAutoReviewer} requires Codex app-server auto approvals`,
  );
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

function selectManagedPolicy<T extends string>(
  allowed: Set<T> | undefined,
  [preferred, alternate, fallback]: readonly [T, T, T],
  requiredMessage: string | undefined,
): T {
  if (allowed === undefined || allowed.has(preferred)) {
    return preferred;
  }
  if (allowed.has(alternate)) {
    return alternate;
  }
  if (requiredMessage) {
    throw new Error(requiredMessage);
  }
  return allowed.has(fallback) ? fallback : preferred;
}
