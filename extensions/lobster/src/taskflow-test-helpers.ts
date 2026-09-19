// Lobster helper module supports taskflow test helpers behavior.
import { vi } from "vitest";
import type { BoundTaskFlow } from "./lobster-taskflow.js";

export function createFakeTaskFlow(
  overrides?: Partial<BoundTaskFlow>,
  waitingRevision = 4,
): BoundTaskFlow {
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

  let current: typeof baseFlow = {
    ...baseFlow,
    status: "waiting",
    revision: waitingRevision,
    waitJson: {
      kind: "lobster_approval",
      prompt: "Continue?",
      items: [],
      resumeToken: "resume-1",
      approvalId: "approval-1",
    },
  };
  const mutate = (input: { expectedRevision: number }, status: typeof current.status) => {
    if (input.expectedRevision !== current.revision) {
      return { applied: false as const, code: "revision_conflict" as const };
    }
    current = { ...current, revision: input.expectedRevision + 1, status };
    return { applied: true as const, flow: current };
  };

  return {
    tryCreateManaged: vi.fn<BoundTaskFlow["tryCreateManaged"]>(
      async () => (current = { ...baseFlow }),
    ),
    get: vi.fn<BoundTaskFlow["get"]>(async () => current),
    list: vi.fn<BoundTaskFlow["list"]>().mockResolvedValue([]),
    setWaiting: vi.fn<BoundTaskFlow["setWaiting"]>(async (input) => mutate(input, "waiting")),
    resume: vi.fn<BoundTaskFlow["resume"]>(async (input) => mutate(input, "running")),
    finish: vi.fn<BoundTaskFlow["finish"]>(async (input) => mutate(input, "succeeded")),
    fail: vi.fn<BoundTaskFlow["fail"]>(async (input) => mutate(input, "failed")),
    cancel: vi.fn<BoundTaskFlow["cancel"]>(),
    ...overrides,
  };
}
