/**
 * Guardian / enterprise-requirements approval+sandbox resolver for the Claude
 * app-server bridge.
 *
 * Mirrors extensions/codex/src/app-server/config.ts (the canonical
 * implementation) detail-for-detail, adapted to Claude's types and stripped of
 * Codex-intrinsic concepts (Claude has no reviewer / model-backed-reviewer
 * notion, so all `approvalsReviewer` logic and the OpenAI model-trust gates are
 * omitted).
 *
 * The bridge DERIVES its default `approvalPolicy` / `sandbox` from:
 *   (a) core exec-policy — `tools.exec.{mode,security,ask}` in openclaw.json
 *       (plus the per-agent override and the exec-approvals floor file), and
 *   (b) an enterprise requirements.toml floor (a Claude-scoped path; same TOML
 *       schema keys as Codex: `allowed_sandbox_modes`,
 *       `allowed_approval_policies`).
 *
 * Precedence (matching Codex): explicit config > env > requirements/guardian-
 * derived default > implicit (`never` / `danger-full-access` in yolo).
 *
 * ── Type difference vs Codex ────────────────────────────────────────────────
 * Codex `sandbox` is a STRING enum (`read-only` / `workspace-write` /
 * `danger-full-access`). Claude's `SandboxPolicy` is an OBJECT
 * (`{ type: "readOnly" | "workspaceWrite" | "dangerFullAccess" }`). All the
 * guardian/requirements machinery below works in the Codex STRING space
 * (`ClaudeSandboxMode`) for a faithful 1:1 mirror, and only the final
 * resolution maps the chosen string mode into Claude's object form via
 * `sandboxModeToPolicy`. The requirements TOML uses the same string spellings
 * Codex parses (`workspace-write`, etc.), so `normalizeRequirementsSandboxMode`
 * is byte-for-byte the Codex implementation.
 */

import { readFileSync } from "node:fs";
import { hostname as readHostName } from "node:os";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { ApprovalPolicy, SandboxPolicy } from "./types.js";

// ── requirements path constants (Claude-scoped, mirroring Codex's) ───────────

/** Unix requirements.toml floor location. Mirrors Codex's UNIX_CODEX_REQUIREMENTS_PATH. */
export const UNIX_CLAUDE_REQUIREMENTS_PATH = "/etc/openclaw-claude/requirements.toml";
/**
 * Windows requirements.toml suffix appended to %ProgramData%. Mirrors Codex's
 * WINDOWS_CODEX_REQUIREMENTS_SUFFIX (`\\OpenAI\\Codex\\requirements.toml`).
 */
export const WINDOWS_CLAUDE_REQUIREMENTS_SUFFIX = "\\OpenClaw\\Claude\\requirements.toml";
/** Env override for the requirements path. Mirrors Codex's env-override pattern. */
export const CLAUDE_APP_SERVER_REQUIREMENTS_ENV = "OPENCLAW_CLAUDE_APP_SERVER_REQUIREMENTS";

// ── sandbox-mode string space (Codex enum) used internally for a 1:1 mirror ──

/** Codex-shaped sandbox-mode strings used by the guardian machinery and the requirements TOML. */
export type ClaudeSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Where the resolved approvalPolicy came from. Mirrors Codex's CodexAppServerApprovalPolicySource. */
export type ClaudeAppServerApprovalPolicySource = "config" | "env" | "requirements" | "implicit";

type ClaudeAppServerPolicyMode = "yolo" | "guardian";

type ClaudeAppServerDefaultPolicy = {
  mode: ClaudeAppServerPolicyMode;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: ClaudeSandboxMode;
  dangerFullAccessAllowed?: boolean;
};

// ── core exec-policy types (the SAME shapes Codex consumes) ──────────────────

type OpenClawExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";
type OpenClawExecSecurity = "deny" | "allowlist" | "full";
type OpenClawExecAsk = "off" | "on-miss" | "always";
type OpenClawExecApprovalFloors = {
  security?: OpenClawExecSecurity;
  ask?: OpenClawExecAsk;
};
export type OpenClawExecPolicyForClaudeAppServer = {
  mode?: OpenClawExecMode;
  security: OpenClawExecSecurity;
  ask: OpenClawExecAsk;
  touched: boolean;
};
type OpenClawExecPolicy = OpenClawExecPolicyForClaudeAppServer;

// ── public resolver result ───────────────────────────────────────────────────

export type ResolveClaudeAppServerPolicyParams = {
  /** Explicit appServer.approvalPolicy from plugin config (wins over everything). */
  configApprovalPolicy?: ApprovalPolicy;
  /** Explicit appServer.sandbox from plugin config (already in Claude object form). */
  configSandbox?: SandboxPolicy;
  env?: NodeJS.ProcessEnv;
  /** Effective core exec-policy for this turn (config + override + approvals floor). */
  execPolicy?: OpenClawExecPolicyForClaudeAppServer;
  /** Inline requirements TOML (tests). When set, overrides file read; `null` => no requirements. */
  requirementsToml?: string | null;
  /** Explicit requirements path override (tests / diagnostics). */
  requirementsPath?: string;
  /** Injected file reader (tests). */
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
  /**
   * Host the bridge runs on, used to match `[[remote_sandbox_config]]`
   * array-tables in the requirements floor (host-glob). Defaults to
   * os.hostname() when unset. Mirrors Codex's `hostName` param.
   */
  hostName?: string;
};

export type ResolvedClaudeAppServerPolicy = {
  approvalPolicy: ApprovalPolicy;
  approvalPolicySource: ClaudeAppServerApprovalPolicySource;
  sandbox: SandboxPolicy;
  /** Resolved policy mode (yolo vs guardian), surfaced for diagnostics/tests. */
  policyMode: ClaudeAppServerPolicyMode;
};

/**
 * Resolve the bridge's default approvalPolicy + sandbox.
 *
 * Mirrors the body of Codex's `resolveCodexAppServerRuntimeOptions`
 * (extensions/codex/src/app-server/config.ts lines ~500-700) for the
 * policy-relevant slice only — no command/transport/headers/serviceTier, no
 * reviewer selection. Claude's bridge is always stdio-local, so the
 * transport!=="stdio" yolo short-circuit is irrelevant and omitted.
 */
export function resolveClaudeAppServerPolicy(
  params: ResolveClaudeAppServerPolicyParams = {},
): ResolvedClaudeAppServerPolicy {
  const env = params.env ?? process.env;
  const execMode = params.execPolicy?.touched === true ? params.execPolicy.mode : undefined;
  assertClaudeAppServerAllowedForOpenClawExecMode(execMode);

  // Guardian forcing signal from exec-mode. Mirrors Codex's
  // resolveCodexPolicyModeForOpenClawExecMode (deny/allowlist already rejected
  // above; full => undefined; everything else => guardian).
  const normalizedPolicyMode = resolveClaudePolicyModeForOpenClawExecMode(execMode);

  // Exec-mode auto/ask demand prompting approvals. Mirrors Codex's
  // execModeRequiringPromptingApprovals (sans the reviewer-driven fallback to
  // "ask" — Claude has no reviewer, so the only sources are auto/ask).
  const execModeRequiringPromptingApprovals: Extract<OpenClawExecMode, "auto" | "ask"> | undefined =
    execMode === "auto" || execMode === "ask" ? execMode : undefined;

  // Legacy full-security-with-always-ask forces danger-full-access. Mirrors
  // Codex's forceDangerFullAccessSandbox.
  const forceDangerFullAccessSandbox =
    params.execPolicy?.touched === true &&
    params.execPolicy.security === "full" &&
    params.execPolicy.ask === "always";

  const forceRuntimePolicy = forceDangerFullAccessSandbox;

  const configuredSandboxMode = sandboxPolicyToMode(params.configSandbox);

  const defaultPolicy = resolveDefaultClaudeAppServerPolicy({
    forceGuardian: normalizedPolicyMode === "guardian",
    execModeRequiringPromptingApprovals,
    requirementsToml: params.requirementsToml,
    requirementsPath: params.requirementsPath,
    readRequirementsFile: params.readRequirementsFile,
    platform: params.platform ?? process.platform,
    hostName: params.hostName,
    env,
  });

  // Forced-policy block. Mirrors Codex's forcedPolicy (minus reviewer); the
  // only Claude force path is the legacy danger-full-access sandbox force.
  const forcedPolicy = forceRuntimePolicy
    ? {
        approvalPolicy: defaultPolicy?.approvalPolicy ?? ("on-request" as ApprovalPolicy),
        sandbox: forceDangerFullAccessSandbox
          ? selectForcedDangerFullAccessSandbox({
              configuredSandbox: configuredSandboxMode,
              defaultPolicy,
            })
          : selectForcedPromptingSandbox({
              configuredSandbox: configuredSandboxMode,
              defaultSandbox: defaultPolicy?.sandbox,
            }),
      }
    : undefined;

  const policyMode: ClaudeAppServerPolicyMode =
    normalizedPolicyMode ?? defaultPolicy?.mode ?? "yolo";

  const resolvedSandboxMode: ClaudeSandboxMode =
    forcedPolicy?.sandbox ??
    configuredSandboxMode ??
    defaultPolicy?.sandbox ??
    (policyMode === "guardian" ? "workspace-write" : "danger-full-access");

  // approvalPolicy precedence: explicit config > env > requirements-derived
  // default > implicit. Mirrors Codex exactly (config/env are resolved by the
  // caller in config.ts and passed in here).
  const configApprovalPolicy = params.configApprovalPolicy;
  const envApprovalPolicy = resolveApprovalPolicy(env.OPENCLAW_CLAUDE_APP_SERVER_APPROVAL_POLICY);
  const approvalPolicy: ApprovalPolicy =
    configApprovalPolicy ??
    envApprovalPolicy ??
    defaultPolicy?.approvalPolicy ??
    (policyMode === "guardian" ? "on-request" : "never");
  const approvalPolicySource: ClaudeAppServerApprovalPolicySource = configApprovalPolicy
    ? "config"
    : envApprovalPolicy
      ? "env"
      : defaultPolicy?.approvalPolicy
        ? "requirements"
        : "implicit";

  return {
    approvalPolicy: forcedPolicy?.approvalPolicy ?? approvalPolicy,
    approvalPolicySource,
    sandbox: sandboxModeToPolicy(resolvedSandboxMode),
    policyMode,
  };
}

// ── default-policy / requirements (mirror of Codex's resolveDefault…Policy) ──

function resolveDefaultClaudeAppServerPolicy(params: {
  forceGuardian?: boolean;
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">;
  requirementsToml?: string | null;
  requirementsPath?: string;
  readRequirementsFile?: (path: string) => string | undefined;
  platform?: NodeJS.Platform;
  hostName?: string;
  env?: NodeJS.ProcessEnv;
}): ClaudeAppServerDefaultPolicy {
  const content = readClaudeRequirementsToml(params);
  if (content === undefined) {
    if (!params.forceGuardian) {
      return { mode: "yolo", dangerFullAccessAllowed: true };
    }
    return {
      mode: "guardian",
      dangerFullAccessAllowed: true,
      approvalPolicy: selectGuardianApprovalPolicy(
        undefined,
        params.execModeRequiringPromptingApprovals,
      ),
      sandbox: selectGuardianSandbox(undefined),
    };
  }
  const allowedSandboxModes = parseAllowedSandboxModesFromRequirements(
    content,
    readNonEmptyString(params.hostName) ?? readHostName(),
  );
  const allowedApprovalPolicies = parseAllowedApprovalPoliciesFromRequirements(content);
  const yoloSandboxAllowed =
    allowedSandboxModes === undefined || allowedSandboxModes.has("danger-full-access");
  const yoloApprovalAllowed =
    allowedApprovalPolicies === undefined || allowedApprovalPolicies.has("never");
  if (!params.forceGuardian && yoloSandboxAllowed && yoloApprovalAllowed) {
    return { mode: "yolo", dangerFullAccessAllowed: true };
  }
  return {
    mode: "guardian",
    dangerFullAccessAllowed: yoloSandboxAllowed,
    approvalPolicy: selectGuardianApprovalPolicy(
      allowedApprovalPolicies,
      params.execModeRequiringPromptingApprovals,
    ),
    sandbox: selectGuardianSandbox(allowedSandboxModes),
  };
}

function readClaudeRequirementsToml(params: {
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
    resolveClaudeRequirementsPath(params.env ?? process.env, params.platform ?? process.platform);
  try {
    if (params.readRequirementsFile) {
      return params.readRequirementsFile(requirementsPath);
    }
    return readFileSync(requirementsPath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveClaudeRequirementsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const envOverride = readNonEmptyString(env[CLAUDE_APP_SERVER_REQUIREMENTS_ENV]);
  if (envOverride) {
    return envOverride;
  }
  if (platform === "win32") {
    const programData = readNonEmptyString(env.ProgramData) ?? "C:\\ProgramData";
    return `${programData.replace(/[\\/]+$/, "")}${WINDOWS_CLAUDE_REQUIREMENTS_SUFFIX}`;
  }
  return UNIX_CLAUDE_REQUIREMENTS_PATH;
}

function parseAllowedSandboxModesFromRequirements(
  content: string,
  hostName: string,
): Set<ClaudeSandboxMode> | undefined {
  // A matching [[remote_sandbox_config]] host-glob takes precedence over the
  // top-level allowed_sandbox_modes floor. Mirrors Codex's
  // parseAllowedSandboxModesFromCodexRequirements.
  const remoteSandboxModes = parseMatchingRemoteSandboxModesFromRequirements(content, hostName);
  if (remoteSandboxModes !== undefined) {
    return remoteSandboxModes;
  }
  const values = parseTopLevelRequirementsStringArray(content, "allowed_sandbox_modes");
  return parseRequirementsSandboxModes(values);
}

function parseMatchingRemoteSandboxModesFromRequirements(
  content: string,
  hostName: string,
): Set<ClaudeSandboxMode> | undefined {
  const normalizedHostName = normalizeRequirementsHostName(hostName);
  if (normalizedHostName === undefined) {
    return undefined;
  }
  for (const section of parseTomlArrayTableSections(content, "remote_sandbox_config")) {
    const patterns = parseRequirementsStringArray(section, "hostname_patterns");
    if (!patterns || !requirementsHostNameMatchesAnyPattern(normalizedHostName, patterns)) {
      continue;
    }
    return parseRequirementsSandboxModes(
      parseRequirementsStringArray(section, "allowed_sandbox_modes"),
    );
  }
  return undefined;
}

function parseAllowedApprovalPoliciesFromRequirements(
  content: string,
): Set<ApprovalPolicy> | undefined {
  const values = parseTopLevelRequirementsStringArray(content, "allowed_approval_policies");
  if (values === undefined) {
    return undefined;
  }
  const normalizedPolicies = values
    .map((entry) => normalizeRequirementsApprovalPolicy(entry))
    .filter((entry): entry is ApprovalPolicy => entry !== undefined);
  return normalizedPolicies.length > 0 ? new Set(normalizedPolicies) : undefined;
}

function parseRequirementsSandboxModes(
  values: string[] | undefined,
): Set<ClaudeSandboxMode> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const normalizedModes = values
    .map((entry) => normalizeRequirementsSandboxMode(entry))
    .filter((entry): entry is ClaudeSandboxMode => entry !== undefined);
  return normalizedModes.length > 0 ? new Set(normalizedModes) : undefined;
}

// ── guardian selectors (mirror of Codex's, sans reviewer) ────────────────────

function selectGuardianApprovalPolicy(
  allowedApprovalPolicies: Set<ApprovalPolicy> | undefined,
  execModeRequiringPromptingApprovals?: Extract<OpenClawExecMode, "auto" | "ask">,
): ApprovalPolicy {
  if (allowedApprovalPolicies === undefined || allowedApprovalPolicies.has("on-request")) {
    return "on-request";
  }
  if (execModeRequiringPromptingApprovals) {
    throw new Error(
      `tools.exec.mode=${execModeRequiringPromptingApprovals} requires Claude app-server prompting approvals`,
    );
  }
  if (allowedApprovalPolicies.has("on-failure")) {
    return "on-failure";
  }
  if (allowedApprovalPolicies.has("untrusted")) {
    return "untrusted";
  }
  if (allowedApprovalPolicies.has("never")) {
    return "never";
  }
  return "on-request";
}

function selectGuardianSandbox(
  allowedSandboxModes: Set<ClaudeSandboxMode> | undefined,
): ClaudeSandboxMode {
  if (allowedSandboxModes === undefined || allowedSandboxModes.has("workspace-write")) {
    return "workspace-write";
  }
  if (allowedSandboxModes.has("read-only")) {
    return "read-only";
  }
  if (allowedSandboxModes.has("danger-full-access")) {
    return "danger-full-access";
  }
  return "workspace-write";
}

function selectForcedPromptingSandbox(params: {
  configuredSandbox?: ClaudeSandboxMode;
  defaultSandbox?: ClaudeSandboxMode;
}): ClaudeSandboxMode {
  if (params.configuredSandbox === "read-only" || params.defaultSandbox === "read-only") {
    return "read-only";
  }
  return params.defaultSandbox ?? "workspace-write";
}

function selectForcedDangerFullAccessSandbox(params: {
  configuredSandbox?: ClaudeSandboxMode;
  defaultPolicy: ClaudeAppServerDefaultPolicy | undefined;
}): ClaudeSandboxMode {
  if (params.configuredSandbox === "read-only") {
    return "read-only";
  }
  if (params.defaultPolicy?.dangerFullAccessAllowed === false) {
    // Codex consults openClawSandboxActive here to decide between throwing and
    // falling back to the guardian sandbox. Claude's filesystem sandbox is
    // enforced separately (resolveSandboxContext in run-attempt) and the bridge
    // sandbox field is informational, so we never hard-throw the turn down on a
    // requirements/legacy-exec conflict; we fall back to the guardian sandbox.
    return params.defaultPolicy.sandbox ?? "workspace-write";
  }
  return "danger-full-access";
}

// ── exec-policy resolvers (mirror of Codex's, same core types) ───────────────

/**
 * Resolve the effective core exec-policy for the Claude app-server: base config
 * (`tools.exec` global + per-agent) layered with any per-turn override and the
 * exec-approvals floor file. Mirrors Codex's
 * `resolveOpenClawExecPolicyForCodexAppServer`.
 */
export function resolveOpenClawExecPolicyForClaudeAppServer(params: {
  execOverrides?: {
    security?: unknown;
    ask?: unknown;
  };
  approvals?: ExecApprovalsFile;
  config?: unknown;
  agentId?: string;
}): OpenClawExecPolicyForClaudeAppServer {
  const basePolicy = resolveOpenClawExecPolicyFromConfig({
    config: params.config,
    agentId: params.agentId,
  });
  const overridePolicy = applyOpenClawExecPolicyLayer(basePolicy, params.execOverrides);
  const approvalFloors = resolveOpenClawExecApprovalFloors({
    approvals: params.approvals,
    agentId: params.agentId,
    policy: overridePolicy,
  });
  return applyOpenClawExecApprovalFloors(overridePolicy, approvalFloors);
}

function resolveOpenClawExecPolicyFromConfig(params: {
  config?: unknown;
  agentId?: string;
}): OpenClawExecPolicy {
  const root = readRecord(params.config);
  const globalExec = readRecord(readRecord(root?.tools)?.exec);
  const globalPolicy = applyOpenClawExecPolicyLayer(createDefaultOpenClawExecPolicy(), globalExec);
  const agentId = params.agentId?.trim();
  if (!agentId) {
    return globalPolicy;
  }
  const agents = readRecord(root?.agents);
  const agentList = Array.isArray(agents?.list) ? agents.list : [];
  const normalizedAgentId = normalizeAgentId(agentId);
  const agentEntry = agentList.find((entry) => {
    const id = readRecord(entry)?.id;
    return typeof id === "string" && normalizeAgentId(id) === normalizedAgentId;
  });
  const agentExec = readRecord(readRecord(readRecord(agentEntry)?.tools)?.exec);
  return applyOpenClawExecPolicyLayer(globalPolicy, agentExec);
}

function resolveClaudePolicyModeForOpenClawExecMode(
  mode: OpenClawExecMode | undefined,
): ClaudeAppServerPolicyMode | undefined {
  if (!mode || mode === "full") {
    return undefined;
  }
  return "guardian";
}

function assertClaudeAppServerAllowedForOpenClawExecMode(mode: OpenClawExecMode | undefined): void {
  if (mode === "deny" || mode === "allowlist") {
    throw new Error(
      `Claude app-server local execution is not available when tools.exec.mode=${mode}`,
    );
  }
}

function createDefaultOpenClawExecPolicy(): OpenClawExecPolicy {
  return {
    security: "full",
    ask: "off",
    touched: false,
  };
}

function applyOpenClawExecPolicyLayer(
  base: OpenClawExecPolicy,
  exec?: { mode?: unknown; security?: unknown; ask?: unknown },
): OpenClawExecPolicy {
  if (!exec) {
    return base;
  }
  const mode = readExecMode(exec.mode);
  if (mode !== undefined) {
    return {
      ...resolveOpenClawExecPolicyForMode(mode),
      touched: true,
    };
  }
  const security = readExecSecurity(exec.security);
  const ask = readExecAsk(exec.ask);
  if (security === undefined && ask === undefined) {
    return base;
  }
  const nextSecurity = security ?? base.security;
  const nextAsk = ask ?? base.ask;
  return {
    mode: resolveOpenClawExecModeFromPolicy({ security: nextSecurity, ask: nextAsk }),
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveOpenClawExecApprovalFloors(params: {
  approvals?: ExecApprovalsFile;
  agentId?: string;
  policy: OpenClawExecPolicy;
}): OpenClawExecApprovalFloors | undefined {
  if (!params.approvals) {
    return undefined;
  }
  return resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: params.policy.security,
      ask: params.policy.ask,
    },
  }).agent;
}

function applyOpenClawExecApprovalFloors(
  base: OpenClawExecPolicy,
  approvalFloors?: OpenClawExecApprovalFloors,
): OpenClawExecPolicy {
  if (!approvalFloors) {
    return base;
  }
  const nextSecurity = approvalFloors.security
    ? minOpenClawExecSecurity(base.security, approvalFloors.security)
    : base.security;
  const nextAsk = approvalFloors.ask ? maxOpenClawExecAsk(base.ask, approvalFloors.ask) : base.ask;
  if (nextSecurity === base.security && nextAsk === base.ask) {
    return base;
  }
  return {
    mode: resolveOpenClawExecModeFromPolicy({ security: nextSecurity, ask: nextAsk }),
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveOpenClawExecPolicyForMode(
  mode: OpenClawExecMode,
): Omit<OpenClawExecPolicy, "touched"> {
  switch (mode) {
    case "deny":
      return { mode, security: "deny", ask: "off" };
    case "allowlist":
      return { mode, security: "allowlist", ask: "off" };
    case "ask":
    case "auto":
      return { mode, security: "allowlist", ask: "on-miss" };
    case "full":
      return { mode, security: "full", ask: "off" };
  }
  const exhaustiveMode: never = mode;
  return exhaustiveMode;
}

function resolveOpenClawExecModeFromPolicy(params: {
  security: OpenClawExecSecurity;
  ask: OpenClawExecAsk;
}): OpenClawExecMode {
  if (params.security === "deny") {
    return "deny";
  }
  if (params.security === "allowlist" && params.ask === "off") {
    return "allowlist";
  }
  if (params.security === "full" && params.ask !== "always") {
    return "full";
  }
  return "ask";
}

function minOpenClawExecSecurity(
  left: OpenClawExecSecurity,
  right: OpenClawExecSecurity,
): OpenClawExecSecurity {
  const order: Record<OpenClawExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[left] <= order[right] ? left : right;
}

function maxOpenClawExecAsk(left: OpenClawExecAsk, right: OpenClawExecAsk): OpenClawExecAsk {
  const order: Record<OpenClawExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[left] >= order[right] ? left : right;
}

function readExecMode(value: unknown): OpenClawExecMode | undefined {
  return value === "deny" ||
    value === "allowlist" ||
    value === "ask" ||
    value === "auto" ||
    value === "full"
    ? value
    : undefined;
}

function readExecSecurity(value: unknown): OpenClawExecSecurity | undefined {
  return value === "deny" || value === "allowlist" || value === "full" ? value : undefined;
}

function readExecAsk(value: unknown): OpenClawExecAsk | undefined {
  return value === "off" || value === "on-miss" || value === "always" ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ── normalizers / resolvers (mirror of Codex's) ──────────────────────────────

function normalizeRequirementsSandboxMode(value: string): ClaudeSandboxMode | undefined {
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

function normalizeRequirementsApprovalPolicy(value: string): ApprovalPolicy | undefined {
  return resolveApprovalPolicy(value.trim().toLowerCase());
}

function resolveApprovalPolicy(value: unknown): ApprovalPolicy | undefined {
  return value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted" ||
    value === "never"
    ? value
    : undefined;
}

// ── Claude sandbox object ↔ Codex string-mode mapping ────────────────────────

function sandboxModeToPolicy(mode: ClaudeSandboxMode): SandboxPolicy {
  if (mode === "read-only") {
    return { type: "readOnly" };
  }
  if (mode === "workspace-write") {
    return { type: "workspaceWrite" };
  }
  return { type: "dangerFullAccess" };
}

function sandboxPolicyToMode(sandbox: SandboxPolicy | undefined): ClaudeSandboxMode | undefined {
  if (!sandbox) {
    return undefined;
  }
  if (sandbox.type === "readOnly") {
    return "read-only";
  }
  if (sandbox.type === "workspaceWrite") {
    return "workspace-write";
  }
  if (sandbox.type === "dangerFullAccess") {
    return "danger-full-access";
  }
  return undefined;
}

// ── TOML parsers (byte-for-byte mirror of Codex's) ───────────────────────────

function parseTopLevelRequirementsStringArray(content: string, key: string): string[] | undefined {
  const topLevelContent = stripTomlLineComments(content).slice(0, firstTomlTableOffset(content));
  return parseRequirementsStringArray(topLevelContent, key);
}

function parseRequirementsStringArray(content: string, key: string): string[] | undefined {
  const match = content.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) {
    return undefined;
  }
  const arrayBody = match[1] ?? "";
  const stringMatches = [...arrayBody.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)];
  if (stringMatches.length === 0 && arrayBody.trim().length > 0) {
    return undefined;
  }
  return stringMatches.map((entry) => entry[1] ?? entry[2] ?? "");
}

function parseTomlArrayTableSections(content: string, table: string): string[] {
  const strippedContent = stripTomlLineComments(content);
  const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerPattern = new RegExp(`^\\s*\\[\\[\\s*${escapedTable}\\s*\\]\\]\\s*$`, "gm");
  const sections: string[] = [];
  for (
    let match = headerPattern.exec(strippedContent);
    match;
    match = headerPattern.exec(strippedContent)
  ) {
    const sectionStart = headerPattern.lastIndex;
    const rest = strippedContent.slice(sectionStart);
    const nextTableOffset = rest.search(/^\s*\[/m);
    sections.push(nextTableOffset === -1 ? rest : rest.slice(0, nextTableOffset));
  }
  return sections;
}

function firstTomlTableOffset(content: string): number {
  const match = content.match(/^\s*\[[^\]\n]/m);
  return match?.index ?? content.length;
}

// ── host-glob matching (byte-for-byte mirror of Codex's) ─────────────────────

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

function stripTomlLineComments(value: string): string {
  let output = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (quote) {
      output += char;
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "#") {
      while (index < value.length && value[index] !== "\n") {
        index += 1;
      }
      if (value[index] === "\n") {
        output += "\n";
      }
      continue;
    }
    output += char;
  }
  return output;
}

// ── small helpers ─────────────────────────────────────────────────────────────

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
