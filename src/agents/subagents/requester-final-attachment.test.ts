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
  return promoteRequesterFinalAttachment({ ...deliveredFinal, ...overrides });
}

function finalize(overrides: Partial<Parameters<typeof finalizeRequesterFinalAttachment>[0]> = {}) {
  finalizeRequesterFinalAttachment({ ...deliveredFinal, ...overrides });
}

describe("requester final attachment", () => {
  let append: ReturnType<typeof vi.fn<() => boolean>>;
  let registration: ReturnType<typeof registerRequesterFinalAttachment>;
  beforeEach(() => {
    lifecycle.generation = "generation-1";
    lifecycle.rotate?.(lifecycle.generation);
    append = vi.fn(() => true);
    registration = registerRequesterFinalAttachment({ ...base, append });
  });

  it("promotes an exact durable batch and consumes it once", () => {
    finalize({ batchRunIds: ["run-a", "run-b"] });
    expect(append).not.toHaveBeenCalled();
    expect(promote({ batchRunIds: ["run-b", "run-a"] })).toBe(true);
    registration.releaseProvisional();

    finalize({ batchRunIds: ["run-a", "run-b"] });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
    finalize({ batchRunIds: ["run-a", "run-b"], finalAssistantVisibleText: "replay" });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
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
