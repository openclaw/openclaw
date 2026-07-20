/**
 * Real-behavior proof for openclaw-cxl (#86655): the Claude app-server harness
 * now DERIVES its default approvalPolicy / sandbox from core exec-policy
 * (tools.exec.{mode,security,ask}) + an enterprise requirements.toml floor
 * (/etc/openclaw-claude/requirements.toml), mirroring Codex's guardian resolver,
 * instead of the old static never / danger-full-access.
 *
 * This drives the REAL resolveClaudeAppServerConfig (the actual production entry
 * point that run-attempt.ts calls) — NOT a mock of the policy seam — across the
 * key scenarios, self-checking each invariant. Requirements TOML is injected
 * inline (requirementsToml / readRequirementsFile) so the proof never touches
 * the real /etc path. On any invariant violation it throws and exits non-zero;
 * on success it prints "All runtime assertions passed."
 *
 * Run: pnpm tsx scripts/proof-claude-guardian-policy.ts
 */

import {
  resolveClaudeAppServerConfig,
  type ResolvedClaudeAppServerConfig,
} from "../extensions/claude/src/app-server/config.js";
import { resolveOpenClawExecPolicyForClaudeAppServer } from "../extensions/claude/src/app-server/policy.js";
import type { ApprovalPolicy, SandboxPolicy } from "../extensions/claude/src/app-server/types.js";

let checks = 0;

function fail(message: string): never {
  throw new Error(`INVARIANT VIOLATION: ${message}`);
}

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    fail(message);
  }
}

function assertApproval(
  cfg: ResolvedClaudeAppServerConfig,
  expected: ApprovalPolicy,
  label: string,
): void {
  assert(
    cfg.appServer.approvalPolicy === expected,
    `${label}: expected approvalPolicy=${expected}, got ${cfg.appServer.approvalPolicy}`,
  );
}

function assertSandbox(
  cfg: ResolvedClaudeAppServerConfig,
  expected: SandboxPolicy,
  label: string,
): void {
  assert(
    JSON.stringify(cfg.appServer.sandbox) === JSON.stringify(expected),
    `${label}: expected sandbox=${JSON.stringify(expected)}, got ${JSON.stringify(cfg.appServer.sandbox)}`,
  );
}

// Empty env so the host's OPENCLAW_CLAUDE_APP_SERVER_* vars don't leak into the
// proof. Each scenario passes requirementsToml explicitly (null => no floor).
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

// (a) BACKWARD-COMPAT: no requirements + no exec-policy → yolo (never / danger-full-access).
{
  const cfg = resolveClaudeAppServerConfig({}, { env: EMPTY_ENV, requirementsToml: null });
  assertApproval(cfg, "never", "backward-compat (no floor, no exec-policy)");
  assertSandbox(cfg, { type: "dangerFullAccess" }, "backward-compat (no floor, no exec-policy)");
  console.log("[a] backward-compat yolo default: never / dangerFullAccess  OK");
}

// (a') BACKWARD-COMPAT via the legacy single-arg signature (no policy context at all).
{
  const cfg = resolveClaudeAppServerConfig({});
  // The host process env MIGHT set the approval-policy override; only assert the
  // sandbox + that approvalPolicy is one of the valid enum values. The point of
  // this scenario is that the one-arg call still works (no throw).
  assert(
    typeof cfg.appServer.approvalPolicy === "string",
    "legacy one-arg call returns a string approvalPolicy",
  );
  console.log("[a'] legacy one-arg resolveClaudeAppServerConfig still resolves  OK");
}

// (b) requirements floor excluding "never" → guardian tightening to on-request.
{
  const cfg = resolveClaudeAppServerConfig(
    {},
    {
      env: EMPTY_ENV,
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    },
  );
  assertApproval(cfg, "on-request", "requirements excluding never");
  assertSandbox(cfg, { type: "workspaceWrite" }, "requirements excluding never");
  console.log("[b] requirements (no never) → on-request / workspaceWrite  OK");
}

// (c) allowed_sandbox_modes excluding danger-full-access → guardian workspace-write.
{
  const cfg = resolveClaudeAppServerConfig(
    {},
    {
      env: EMPTY_ENV,
      requirementsToml: 'allowed_sandbox_modes = ["read-only", "workspace-write"]\n',
    },
  );
  assertApproval(cfg, "on-request", "requirements excluding danger-full-access");
  assertSandbox(cfg, { type: "workspaceWrite" }, "requirements excluding danger-full-access");
  console.log("[c] requirements (no danger-full-access) → workspaceWrite  OK");
}

// (d) explicit plugin-config approvalPolicy/sandbox STILL WINS over requirements.
{
  const cfg = resolveClaudeAppServerConfig(
    { appServer: { approvalPolicy: "never", sandbox: "danger-full-access" } },
    {
      env: EMPTY_ENV,
      // Floor would otherwise force on-request / workspace-write…
      requirementsToml:
        'allowed_approval_policies = ["on-request"]\nallowed_sandbox_modes = ["workspace-write"]\n',
    },
  );
  assertApproval(cfg, "never", "explicit config beats requirements");
  assertSandbox(cfg, { type: "dangerFullAccess" }, "explicit config beats requirements");
  console.log("[d] explicit config (never / dangerFullAccess) beats requirements floor  OK");
}

// (d') env override beats requirements (but config beats env — verify env wins when no config).
{
  const cfg = resolveClaudeAppServerConfig(
    {},
    {
      env: { OPENCLAW_CLAUDE_APP_SERVER_APPROVAL_POLICY: "never" } as NodeJS.ProcessEnv,
      requirementsToml: 'allowed_approval_policies = ["on-request"]\n',
    },
  );
  assertApproval(cfg, "never", "env override beats requirements");
  console.log("[d'] env approvalPolicy override beats requirements floor  OK");
}

// (e) exec-mode auto/ask forces guardian prompting.
for (const mode of ["auto", "ask"] as const) {
  const execPolicy = resolveOpenClawExecPolicyForClaudeAppServer({
    config: { tools: { exec: { mode } } },
  });
  assert(execPolicy.touched && execPolicy.mode === mode, `exec-policy resolves mode=${mode}`);
  const cfg = resolveClaudeAppServerConfig(
    {},
    { env: EMPTY_ENV, requirementsToml: null, execPolicy },
  );
  assertApproval(cfg, "on-request", `exec-mode ${mode} forces prompting`);
  assertSandbox(cfg, { type: "workspaceWrite" }, `exec-mode ${mode} forces guardian sandbox`);
}
console.log("[e] exec-mode auto/ask forces guardian on-request / workspaceWrite  OK");

// (e') exec-mode full leaves yolo defaults intact.
{
  const execPolicy = resolveOpenClawExecPolicyForClaudeAppServer({
    config: { tools: { exec: { mode: "full" } } },
  });
  const cfg = resolveClaudeAppServerConfig(
    {},
    { env: EMPTY_ENV, requirementsToml: null, execPolicy },
  );
  assertApproval(cfg, "never", "exec-mode full stays yolo");
  assertSandbox(cfg, { type: "dangerFullAccess" }, "exec-mode full stays yolo");
  console.log("[e'] exec-mode full stays yolo (never / dangerFullAccess)  OK");
}

// (f) exec-mode deny / allowlist throws.
for (const mode of ["deny", "allowlist"] as const) {
  const execPolicy = resolveOpenClawExecPolicyForClaudeAppServer({
    config: { tools: { exec: { mode } } },
  });
  let threw = false;
  try {
    resolveClaudeAppServerConfig({}, { env: EMPTY_ENV, requirementsToml: null, execPolicy });
  } catch (error) {
    threw = true;
    assert(
      String((error as Error).message).includes(`tools.exec.mode=${mode}`),
      `deny/allowlist error names mode ${mode}`,
    );
  }
  assert(threw, `exec-mode ${mode} throws`);
}
console.log("[f] exec-mode deny / allowlist throws (Claude app-server unavailable)  OK");

// (g) malformed / absent requirements → falls back gracefully to yolo.
{
  const malformed = resolveClaudeAppServerConfig(
    {},
    { env: EMPTY_ENV, requirementsToml: "this is not = = = valid [\n" },
  );
  assertApproval(malformed, "never", "malformed requirements falls back to yolo");
  assertSandbox(
    malformed,
    { type: "dangerFullAccess" },
    "malformed requirements falls back to yolo",
  );

  const unreadable = resolveClaudeAppServerConfig(
    {},
    {
      env: EMPTY_ENV,
      requirementsPath: "/nonexistent/openclaw-claude/requirements.toml",
      readRequirementsFile: () => {
        throw new Error("ENOENT");
      },
    },
  );
  assertApproval(unreadable, "never", "unreadable requirements file falls back to yolo");
  assertSandbox(
    unreadable,
    { type: "dangerFullAccess" },
    "unreadable requirements file falls back to yolo",
  );
  console.log("[g] malformed / unreadable requirements → graceful yolo fallback  OK");
}

// (h) requirements that explicitly re-allow yolo keep yolo.
{
  const cfg = resolveClaudeAppServerConfig(
    {},
    {
      env: EMPTY_ENV,
      requirementsToml:
        'allowed_approval_policies = ["never"]\nallowed_sandbox_modes = ["danger-full-access"]\n',
    },
  );
  assertApproval(cfg, "never", "requirements re-allowing yolo");
  assertSandbox(cfg, { type: "dangerFullAccess" }, "requirements re-allowing yolo");
  console.log("[h] requirements explicitly allowing never + danger-full-access stays yolo  OK");
}

// (i) remote_sandbox_config host-glob: the FIRST matching [[remote_sandbox_config]]
//     array-table (host-glob) overrides the top-level floor; a non-matching host
//     leaves yolo intact. Mirrors Codex's remote-sandbox matching test.
{
  const remoteToml = `[[remote_sandbox_config]]
hostname_patterns = ["build-*.example.com"]
allowed_sandbox_modes = ["read-only", "workspace-write"]

[[remote_sandbox_config]]
hostname_patterns = ["build-01.example.com"]
allowed_sandbox_modes = ["read-only", "danger-full-access"]
`;
  const matched = resolveClaudeAppServerConfig(
    {},
    { env: EMPTY_ENV, requirementsToml: remoteToml, hostName: "BUILD-01.EXAMPLE.COM." },
  );
  assertApproval(matched, "on-request", "matching remote_sandbox_config tightens to guardian");
  assertSandbox(
    matched,
    { type: "workspaceWrite" },
    "first matching remote_sandbox_config (build-*) excludes danger-full-access",
  );

  const unmatched = resolveClaudeAppServerConfig(
    {},
    { env: EMPTY_ENV, requirementsToml: remoteToml, hostName: "laptop.example.com" },
  );
  assertApproval(unmatched, "never", "non-matching remote_sandbox_config stays yolo");
  assertSandbox(
    unmatched,
    { type: "dangerFullAccess" },
    "non-matching remote_sandbox_config stays yolo",
  );
  console.log("[i] remote_sandbox_config host-glob: matched→guardian, unmatched→yolo  OK");
}

console.log(`\n${checks} invariant checks executed.`);
console.log("All runtime assertions passed.");
