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
  revokeRequesterFinalAttachment,
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
  return promoteRequesterFinalAttachment({ ...deliveredFinal, ...overrides });
}

function finalize(overrides: Partial<Parameters<typeof finalizeRequesterFinalAttachment>[0]> = {}) {
  finalizeRequesterFinalAttachment({ ...deliveredFinal, ...overrides });
}

describe("requester final attachment", () => {
  let append: ReturnType<typeof vi.fn<() => boolean>>;
  let onPromoted: ReturnType<typeof vi.fn<() => void>>;
  let registration: ReturnType<typeof registerRequesterFinalAttachment>;
  beforeEach(() => {
    lifecycle.generation = "generation-1";
    lifecycle.rotate?.(lifecycle.generation);
    append = vi.fn(() => true);
    onPromoted = vi.fn();
    registration = registerRequesterFinalAttachment({ ...base, append, onPromoted });
  });

  it("promotes an exact durable batch and consumes it once", () => {
    finalize({ batchRunIds: ["run-a", "run-b"] });
    expect(append).not.toHaveBeenCalled();
    expect(promote({ batchRunIds: ["run-b", "run-a"] })).toBe(true);
    expect(promote({ batchRunIds: ["run-b", "run-a"] })).toBe(true);
    expect(onPromoted).toHaveBeenCalledOnce();
    registration.releaseProvisional();

    finalize({ batchRunIds: ["run-a", "run-b"] });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
    finalize({ batchRunIds: ["run-a", "run-b"], finalAssistantVisibleText: "replay" });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("keeps overlapping yielded requester turns independently deliverable", () => {
    const second = vi.fn(() => true);
    const secondRegistration = registerRequesterFinalAttachment({
      ...base,
      requesterTurnRunId: "run-requester-2",
      append: second,
    });

    expect(promote({ batchRunIds: ["run-a"], rearmGeneration: 1 })).toBe(true);
    expect(
      promote({
        requesterTurnRunId: "run-requester-2",
        batchRunIds: ["run-b"],
        rearmGeneration: 2,
      }),
    ).toBe(true);
    registration.releaseProvisional();
    secondRegistration.releaseProvisional();

    finalize({ batchRunIds: ["run-b"], rearmGeneration: 2, finalAssistantVisibleText: "second" });
    finalize({ batchRunIds: ["run-a"], rearmGeneration: 1, finalAssistantVisibleText: "first" });
    expect(second).toHaveBeenCalledExactlyOnceWith("second");
    expect(append).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("revokes every overlapping attachment for a requester session", () => {
    const second = vi.fn(() => true);
    registerRequesterFinalAttachment({
      ...base,
      requesterTurnRunId: "run-requester-2",
      append: second,
    });
    expect(promote({ batchRunIds: ["run-a"], rearmGeneration: 1 })).toBe(true);
    expect(
      promote({
        requesterTurnRunId: "run-requester-2",
        batchRunIds: ["run-b"],
        rearmGeneration: 2,
      }),
    ).toBe(true);

    expect(
      revokeRequesterFinalAttachment({
        requesterAgentId: base.requesterAgentId,
        requesterSessionKey: base.requesterSessionKey,
        requesterSessionId: base.requesterSessionId,
      }),
    ).toBe(true);
    finalize({ batchRunIds: ["run-a"], rearmGeneration: 1, finalAssistantVisibleText: "first" });
    finalize({ batchRunIds: ["run-b"], rearmGeneration: 2, finalAssistantVisibleText: "second" });
    expect(append).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("rejects the wrong session or batch without consuming the owner", () => {
    promote({ rearmGeneration: 2 });

    finalize({ requesterSessionId: "session-other", rearmGeneration: 2 });
    finalize({
      batchRunIds: ["run-b"],
      rearmGeneration: 2,
      finalAssistantVisibleText: "wrong batch",
    });
    finalize({ rearmGeneration: 1 });
    expect(append).not.toHaveBeenCalled();
    finalize({ rearmGeneration: 2 });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it.each(["rotated", "current"])("only the %s lifecycle can finalize a replacement", (state) => {
    const rearmGeneration = state === "rotated" ? 1 : 3;
    const second = vi.fn(() => true);
    registerRequesterFinalAttachment({ ...base, requesterTurnRunId: "run-new", append: second });
    registration.revoke();
    expect(promote({ requesterTurnRunId: "run-new", rearmGeneration })).toBe(true);

    if (state === "rotated") {
      lifecycle.generation = "generation-2";
      lifecycle.rotate?.(lifecycle.generation);
    }
    finalize({
      rearmGeneration,
      finalAssistantVisibleText: state === "rotated" ? "stale" : "new final",
    });
    expect(append).not.toHaveBeenCalled();
    if (state === "rotated") {
      expect(second).not.toHaveBeenCalled();
    } else {
      expect(second).toHaveBeenCalledExactlyOnceWith("new final");
    }
  });

  it("consumes a throwing callback without failing or replaying finalization", () => {
    append.mockImplementation(() => {
      throw new Error("socket closed");
    });
    promote();

    finalize();
    finalize({ finalAssistantVisibleText: "replay" });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("keeps promotion durable when its observer has retired", () => {
    onPromoted.mockImplementation(() => {
      throw new Error("voice session closed");
    });

    expect(promote()).toBe(true);
    registration.releaseProvisional();
    finalize();

    expect(onPromoted).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("drops an expired provisional attachment", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      registerRequesterFinalAttachment({ ...base, timeoutMs: 10, append });
      vi.setSystemTime(1_011);
      expect(promote()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
