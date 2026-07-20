import { describe, expect, it } from "vitest";
import {
  resolveClaudeAppServerPolicy,
  resolveOpenClawExecPolicyForClaudeAppServer,
  type ResolveClaudeAppServerPolicyParams,
} from "./policy.js";
import type { SandboxPolicy } from "./types.js";

// Drive the REAL resolver. requirementsToml: null => no enterprise floor (the
// common case), env defaulted to {} so the OPENCLAW_CLAUDE_APP_SERVER_APPROVAL_POLICY
// env override doesn't leak in from the host. Mirrors codex config.test.ts's
// resolveRuntimeForTest helper.
function resolvePolicyForTest(params: Partial<ResolveClaudeAppServerPolicyParams> = {}) {
  return resolveClaudeAppServerPolicy({
    env: {} as NodeJS.ProcessEnv,
    requirementsToml: null,
    ...params,
  });
}

function expectPolicy(
  policy: ReturnType<typeof resolveClaudeAppServerPolicy>,
  expected: { approvalPolicy: string; sandbox: SandboxPolicy },
) {
  expect(policy.approvalPolicy).toBe(expected.approvalPolicy);
  expect(policy.sandbox).toEqual(expected.sandbox);
}

describe("resolveClaudeAppServerPolicy", () => {
  it("defaults to yolo (never / danger-full-access) with no requirements and no exec-policy", () => {
    const policy = resolvePolicyForTest();
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(policy.policyMode).toBe("yolo");
    expect(policy.approvalPolicySource).toBe("implicit");
  });

  it("tightens to guardian (on-request / workspace-write) when requirements disallow full access", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    });
    expect(policy.policyMode).toBe("guardian");
    expect(policy.approvalPolicySource).toBe("requirements");
  });

  it("uses read-only guardian sandbox when requirements only allow read-only", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: 'allowed_sandbox_modes = ["read-only"]\n',
    });
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly" },
    });
  });

  it("tightens to guardian when requirements disallow the never approval policy", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    });
  });

  it("selects an allowed guardian approval policy when on-request is unavailable", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: 'allowed_approval_policies = ["on-failure"]\n',
    });
    expectPolicy(policy, {
      approvalPolicy: "on-failure",
      sandbox: { type: "workspaceWrite" },
    });
  });

  it("keeps yolo defaults when requirements explicitly allow never approval and full access", () => {
    const policy = resolvePolicyForTest({
      requirementsToml:
        'allowed_approval_policies = ["never"]\nallowed_sandbox_modes = ["danger-full-access"]\n',
    });
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(policy.policyMode).toBe("yolo");
  });

  it("ignores quoted sandbox modes inside requirements comments", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: `allowed_sandbox_modes = [
  # "danger-full-access",
  "workspace-write",
]
`,
    });
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    });
  });

  it("forces guardian prompting approvals when exec-mode is auto", () => {
    const policy = resolvePolicyForTest({
      execPolicy: { mode: "auto", security: "allowlist", ask: "on-miss", touched: true },
    });
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    });
    expect(policy.policyMode).toBe("guardian");
  });

  it("forces guardian prompting approvals when exec-mode is ask", () => {
    const policy = resolvePolicyForTest({
      execPolicy: { mode: "ask", security: "allowlist", ask: "on-miss", touched: true },
    });
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    });
  });

  it("throws when exec-mode auto cannot satisfy required prompting approvals", () => {
    // Requirements floor disallows every prompting policy → guardian can't honor
    // the auto exec-mode's demand for prompting approvals. Mirrors codex's
    // selectGuardianApprovalPolicy throw.
    expect(() =>
      resolvePolicyForTest({
        requirementsToml: 'allowed_approval_policies = ["never"]\n',
        execPolicy: { mode: "auto", security: "allowlist", ask: "on-miss", touched: true },
      }),
    ).toThrow(/requires Claude app-server prompting approvals/);
  });

  it("leaves yolo defaults untouched when exec-mode is full", () => {
    const policy = resolvePolicyForTest({
      execPolicy: { mode: "full", security: "full", ask: "off", touched: true },
    });
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(policy.policyMode).toBe("yolo");
  });

  it("rejects local execution when exec-mode is deny", () => {
    expect(() =>
      resolvePolicyForTest({
        execPolicy: { mode: "deny", security: "deny", ask: "off", touched: true },
      }),
    ).toThrow(/not available when tools.exec.mode=deny/);
  });

  it("forces danger-full-access for legacy full security with always ask", () => {
    const policy = resolvePolicyForTest({
      execPolicy: { mode: "ask", security: "full", ask: "always", touched: true },
    });
    expect(policy.sandbox).toEqual({ type: "dangerFullAccess" });
  });

  it("falls back to the guardian sandbox when legacy-full forcing conflicts with a requirements floor", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
      execPolicy: { mode: "ask", security: "full", ask: "always", touched: true },
    });
    // danger-full-access is disallowed by the floor; the resolver does not
    // hard-throw the turn (unlike codex) — it falls back to the guardian
    // sandbox. See selectForcedDangerFullAccessSandbox.
    expect(policy.sandbox).toEqual({ type: "workspaceWrite" });
  });

  // ── precedence: explicit config / env beat requirements ────────────────────

  it("lets an explicit config approvalPolicy beat the requirements-derived default", () => {
    const policy = resolvePolicyForTest({
      configApprovalPolicy: "never",
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });
    expect(policy.approvalPolicy).toBe("never");
    expect(policy.approvalPolicySource).toBe("config");
  });

  it("lets an explicit config sandbox beat the requirements-derived default", () => {
    const policy = resolvePolicyForTest({
      configSandbox: { type: "readOnly" },
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    });
    expect(policy.sandbox).toEqual({ type: "readOnly" });
  });

  it("lets an env approvalPolicy override beat the requirements-derived default", () => {
    const policy = resolvePolicyForTest({
      env: { OPENCLAW_CLAUDE_APP_SERVER_APPROVAL_POLICY: "never" } as NodeJS.ProcessEnv,
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });
    expect(policy.approvalPolicy).toBe("never");
    expect(policy.approvalPolicySource).toBe("env");
  });

  it("ignores an invalid env approvalPolicy and keeps the requirements default", () => {
    const policy = resolvePolicyForTest({
      env: { OPENCLAW_CLAUDE_APP_SERVER_APPROVAL_POLICY: "bogus" } as NodeJS.ProcessEnv,
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    });
    expect(policy.approvalPolicy).toBe("on-request");
    expect(policy.approvalPolicySource).toBe("requirements");
  });

  // ── malformed requirements → safe fallback ─────────────────────────────────

  it("falls back to yolo defaults when requirements TOML is malformed/empty of recognized keys", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: "this is not valid toml = = = [\n",
    });
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(policy.policyMode).toBe("yolo");
  });

  it("falls back to yolo defaults when the requirements file cannot be read", () => {
    const policy = resolveClaudeAppServerPolicy({
      env: {} as NodeJS.ProcessEnv,
      requirementsPath: "/nonexistent/openclaw-claude/requirements.toml",
      readRequirementsFile: () => {
        throw new Error("ENOENT");
      },
    });
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
  });

  // ── remote_sandbox_config host-glob matching (mirror of Codex) ─────────────

  it("applies the first matching remote sandbox requirements before the top-level floor", () => {
    const policy = resolvePolicyForTest({
      hostName: "BUILD-01.EXAMPLE.COM.",
      requirementsToml: `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]

[[remote_sandbox_config]]
hostname_patterns = ["build-01.example.com"]
allowed_sandbox_modes = ["read-only", "danger-full-access"]
`,
    });
    // The FIRST matching array-table wins (build-*.example.com matches the
    // normalized host before the more-specific build-01 entry is consulted),
    // so danger-full-access is excluded → guardian workspace-write.
    expectPolicy(policy, {
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite" },
    });
    expect(policy.policyMode).toBe("guardian");
  });

  it("ignores non-matching remote-only sandbox requirements (stays yolo)", () => {
    const policy = resolvePolicyForTest({
      hostName: "laptop.example.com",
      requirementsToml: `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]
`,
    });
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(policy.policyMode).toBe("yolo");
  });

  it("ignores unrecognized sandbox-mode tokens, treating the list as empty (yolo)", () => {
    const policy = resolvePolicyForTest({
      requirementsToml: 'allowed_sandbox_modes = ["totally-bogus"]\n',
    });
    // No recognized modes => parseRequirementsSandboxModes returns undefined =>
    // treated as "no floor" => yolo.
    expectPolicy(policy, {
      approvalPolicy: "never",
      sandbox: { type: "dangerFullAccess" },
    });
  });
});

describe("resolveOpenClawExecPolicyForClaudeAppServer", () => {
  it("is untouched with no exec config", () => {
    const policy = resolveOpenClawExecPolicyForClaudeAppServer({ config: {} });
    expect(policy.touched).toBe(false);
    expect(policy.security).toBe("full");
    expect(policy.ask).toBe("off");
  });

  it("derives mode=ask/auto from tools.exec.mode in the root config", () => {
    const policy = resolveOpenClawExecPolicyForClaudeAppServer({
      config: { tools: { exec: { mode: "auto" } } },
    });
    expect(policy.touched).toBe(true);
    expect(policy.mode).toBe("auto");
    expect(policy.security).toBe("allowlist");
    expect(policy.ask).toBe("on-miss");
  });

  it("derives a mode from explicit security + ask", () => {
    const policy = resolveOpenClawExecPolicyForClaudeAppServer({
      config: { tools: { exec: { security: "full", ask: "always" } } },
    });
    expect(policy.touched).toBe(true);
    expect(policy.mode).toBe("ask");
    expect(policy.security).toBe("full");
    expect(policy.ask).toBe("always");
  });

  it("applies a per-agent tools.exec override on top of the global policy", () => {
    const policy = resolveOpenClawExecPolicyForClaudeAppServer({
      config: {
        tools: { exec: { mode: "full" } },
        agents: { list: [{ id: "alice", tools: { exec: { mode: "ask" } } }] },
      },
      agentId: "alice",
    });
    expect(policy.mode).toBe("ask");
  });

  it("lets a per-turn execOverride win over config", () => {
    const policy = resolveOpenClawExecPolicyForClaudeAppServer({
      config: { tools: { exec: { mode: "full" } } },
      execOverrides: { security: "allowlist", ask: "on-miss" },
    });
    expect(policy.security).toBe("allowlist");
    expect(policy.ask).toBe("on-miss");
    expect(policy.touched).toBe(true);
  });
});
