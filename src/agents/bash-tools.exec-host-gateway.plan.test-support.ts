import { expect } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";

export function createExecApprovalsFixture(): Pick<
  ExecApprovalsResolved,
  "agent" | "allowlist" | "file"
> {
  // Fixtures set resolved host policy separately; host-floor cases supply their own agent.
  return {
    agent: { security: "full", ask: "off", askFallback: "deny", autoAllowSkills: false },
    allowlist: [],
    file: { version: 1, agents: {} },
  };
}

export async function planAllowlistedNodeVersion() {
  const command = "node --version";
  const authorizationPlan = await planShellAuthorization({ command, env: process.env });
  expect(authorizationPlan.ok).toBe(true);
  if (!authorizationPlan.ok) {
    throw new Error(authorizationPlan.reason);
  }
  const segments = authorizationPlan.groups.flatMap((group) =>
    group.candidates.map((candidate) => candidate.sourceSegment),
  );
  const enforced = buildAuthorizedShellCommandFromPlan({
    plan: authorizationPlan,
    mode: "enforced",
    segmentSatisfiedBy: ["allowlist"],
  });
  expect(enforced.ok).toBe(true);
  if (!enforced.ok) {
    throw new Error(enforced.reason);
  }
  return { command, authorizationPlan, segments, enforcedCommand: enforced.command };
}
