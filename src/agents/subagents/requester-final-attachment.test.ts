import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  generation: "generation-1",
  rotate: undefined as ((generation: string) => void) | undefined,
}));

vi.mock("../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => lifecycle.generation,
  registerAgentEventLifecycleRotationHandler: (
    _key: string,
    handler: (generation: string) => void,
  ) => {
    lifecycle.rotate = handler;
  },
}));

import {
  finalizeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
  registerRequesterFinalAttachment,
} from "./requester-final-attachment.js";

const base = {
  requesterAgentId: "main",
  requesterSessionKey: "agent:main:talk",
  requesterSessionId: "session-talk",
  requesterTurnRunId: "run-requester",
  lifecycleGeneration: "generation-1",
  timeoutMs: 60_000,
};

const deliveredFinal = {
  ...base,
  requesterYieldBatch: true,
  pause: false,
  delivered: true,
  batchRunIds: ["run-a"],
  rearmGeneration: 1,
  finalAssistantVisibleText: "final",
};

function promote(overrides: Partial<Parameters<typeof promoteRequesterFinalAttachment>[0]> = {}) {
  return promoteRequesterFinalAttachment({ ...base, ...deliveredFinal, ...overrides });
}

function finalize(overrides: Partial<Parameters<typeof finalizeRequesterFinalAttachment>[0]> = {}) {
  finalizeRequesterFinalAttachment({ ...deliveredFinal, ...overrides });
}

describe("requester final attachment", () => {
  beforeEach(() => {
    lifecycle.generation = "generation-1";
    lifecycle.rotate?.(lifecycle.generation);
  });

  it("promotes an exact durable batch and consumes it once", () => {
    const append = vi.fn(() => true);
    const registration = registerRequesterFinalAttachment({ ...base, append });

    finalize({ batchRunIds: ["run-a", "run-b"] });
    expect(append).not.toHaveBeenCalled();
    expect(promote({ batchRunIds: ["run-b", "run-a"] })).toBe(true);
    registration.releaseProvisional();

    finalize({ batchRunIds: ["run-a", "run-b"] });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
    finalize({
      batchRunIds: ["run-a", "run-b"],
      finalAssistantVisibleText: "replay",
    });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("rejects the wrong session or batch without consuming the owner", () => {
    const append = vi.fn(() => true);
    registerRequesterFinalAttachment({ ...base, append });
    promote({ rearmGeneration: 2 });

    finalize({
      requesterSessionId: "session-other",
      rearmGeneration: 2,
      finalAssistantVisibleText: "wrong session",
    });
    finalize({
      batchRunIds: ["run-b"],
      rearmGeneration: 2,
      finalAssistantVisibleText: "wrong batch",
    });
    expect(append).not.toHaveBeenCalled();
    finalize({ rearmGeneration: 2 });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it.each([
    ["rotated", 1],
    ["current", 3],
  ] as const)("only the %s lifecycle can finalize a replacement", (state, rearmGeneration) => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const firstRegistration = registerRequesterFinalAttachment({ ...base, append: first });
    registerRequesterFinalAttachment({
      ...base,
      requesterTurnRunId: "run-new",
      append: second,
    });
    firstRegistration.revoke();
    expect(
      promote({
        requesterTurnRunId: "run-new",
        batchRunIds: ["run-new-child"],
        rearmGeneration,
      }),
    ).toBe(true);

    if (state === "rotated") {
      lifecycle.generation = "generation-2";
      lifecycle.rotate?.(lifecycle.generation);
    }
    finalize({
      batchRunIds: ["run-new-child"],
      rearmGeneration,
      finalAssistantVisibleText: state === "rotated" ? "stale" : "new final",
    });
    expect(first).not.toHaveBeenCalled();
    if (state === "rotated") {
      expect(second).not.toHaveBeenCalled();
    } else {
      expect(second).toHaveBeenCalledExactlyOnceWith("new final");
    }
  });

  it("consumes a throwing callback without failing or replaying finalization", () => {
    const append = vi.fn(() => {
      throw new Error("socket closed");
    });
    registerRequesterFinalAttachment({ ...base, append });
    promote();

    finalize();
    finalize({ finalAssistantVisibleText: "replay" });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("drops an expired provisional attachment", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      registerRequesterFinalAttachment({ ...base, timeoutMs: 10, append: vi.fn(() => true) });
      vi.setSystemTime(1_011);
      expect(promote()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
