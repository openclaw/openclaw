import { expect } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

export type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

export type HostRevocationContext = {
  host: ReturnType<typeof createAgentHarnessHostCapabilities>;
  attempt: HostAttempt;
  admission: PreparedAgentRunAdmission;
};

export const policyRevocations = [
  {
    name: "lexical host closure",
    revoke: async ({ host }: HostRevocationContext) => {
      host.close();
    },
  },
  {
    name: "exact authority release",
    revoke: async ({ attempt }: HostRevocationContext) => {
      expect(closeAdmittedRunDelegatedAuthority(attempt.admittedRunContext)).toBe(true);
    },
  },
  {
    name: "replacement owner",
    revoke: async ({ attempt }: HostRevocationContext) => {
      await admittedAttempt(attempt.runId);
    },
  },
];

const admissions: PreparedAgentRunAdmission[] = [];

export async function admittedAttempt(
  runId = "run-1",
  overrides: Omit<Partial<HostAttempt>, "admittedRunContext" | "runId"> = {},
): Promise<{ attempt: HostAttempt; admission: PreparedAgentRunAdmission }> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${runId}`);
  return {
    admission,
    attempt: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId,
      cwd: "/attempt/worktree",
      workspaceDir: "/workspace",
      currentChannelId: "chat-1",
      messageChannel: "telegram",
      ...overrides,
      admittedRunContext,
    },
  };
}

export function cleanupHostCapabilityTestAdmissions(): void {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetAgentRunRegistryForTest();
}
