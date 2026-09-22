// Lobster helper module supports taskflow test helpers behavior.
import { vi } from "vitest";
import type { BoundTaskFlow } from "./lobster-taskflow.js";

export function createFakeTaskFlow(overrides?: Partial<BoundTaskFlow>): BoundTaskFlow {
  const baseFlow: NonNullable<Awaited<ReturnType<BoundTaskFlow["tryCreateManaged"]>>> = {
    flowId: "flow-1",
    revision: 1,
    syncMode: "managed" as const,
    controllerId: "tests/lobster",
    ownerKey: "agent:main:main",
    status: "running" as const,
    goal: "Run Lobster workflow",
    notifyPolicy: "silent",
    createdAt: 1,
    updatedAt: 1,
  };

  return {
    get: vi.fn<BoundTaskFlow["get"]>().mockResolvedValue({
      ...baseFlow,
      revision: 4,
      status: "waiting",
      waitJson: { kind: "lobster_approval", resumeToken: "resume-1", approvalId: "approval-1" },
    }),
    tryCreateManaged: vi.fn<BoundTaskFlow["tryCreateManaged"]>().mockResolvedValue(baseFlow),
    setWaiting: vi.fn<BoundTaskFlow["setWaiting"]>(async (input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "waiting" as const },
    })),
    resume: vi.fn<BoundTaskFlow["resume"]>(async (input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "running" as const },
    })),
    finish: vi.fn<BoundTaskFlow["finish"]>(async (input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "succeeded" as const },
    })),
    fail: vi.fn<BoundTaskFlow["fail"]>(async (input) => ({
      applied: true,
      flow: { ...baseFlow, revision: input.expectedRevision + 1, status: "failed" as const },
    })),
    cancel: vi.fn<BoundTaskFlow["cancel"]>(),
    ...overrides,
  };
}
