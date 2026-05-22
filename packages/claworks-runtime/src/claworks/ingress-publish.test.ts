import { describe, expect, it, vi } from "vitest";
import { applyIngressPublish } from "./ingress-publish.js";
import { DEFAULT_ROBOT_CONSTITUTION } from "./robot-constitution.js";
import type { ClaworksRuntime } from "./runtime-types.js";

function mockRuntime(overrides?: Partial<ClaworksRuntime>): ClaworksRuntime {
  return {
    identity: {
      constitution: DEFAULT_ROBOT_CONSTITUTION,
    },
    ingress: {
      decide: () => ({ action: "kernel" as const }),
    },
    kernel: {
      publish: vi.fn().mockResolvedValue([]),
    },
    playbookEngine: { list: () => [], trigger: vi.fn() },
    logger: vi.fn(),
    ...overrides,
  } as unknown as ClaworksRuntime;
}

describe("applyIngressPublish trusted sources", () => {
  it("denies untrusted publish sources", async () => {
    const runtime = mockRuntime();
    const result = await applyIngressPublish(runtime, {
      source: "rest",
      eventType: "evil.created",
      subjectId: "x",
      payload: {},
      publishSource: "untrusted-origin",
    });
    expect(result.action).toBe("denied");
  });

  it("allows system sources", async () => {
    const runtime = mockRuntime();
    const result = await applyIngressPublish(runtime, {
      source: "rest",
      eventType: "alarm.created",
      subjectId: "x",
      payload: { priority: "P1" },
      publishSource: "test",
    });
    expect(result.action).toBe("published");
  });
});
