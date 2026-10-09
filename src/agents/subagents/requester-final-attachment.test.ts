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
};

describe("requester final attachment", () => {
  beforeEach(() => {
    lifecycle.generation = "generation-1";
    lifecycle.rotate?.(lifecycle.generation);
  });

  it("promotes an exact durable batch and consumes it once", () => {
    const append = vi.fn(() => true);
    const registration = registerRequesterFinalAttachment({ ...base, append });

    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-a", "run-b"],
      rearmGeneration: 1,
      finalAssistantVisibleText: "final",
    });
    expect(append).not.toHaveBeenCalled();
    expect(
      promoteRequesterFinalAttachment({
        requesterAgentId: base.requesterAgentId,
        requesterSessionKey: base.requesterSessionKey,
        requesterTurnRunId: base.requesterTurnRunId,
        batchRunIds: ["run-b", "run-a"],
        rearmGeneration: 1,
      }),
    ).toBe(true);
    registration.releaseProvisional();

    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-a", "run-b"],
      rearmGeneration: 1,
      finalAssistantVisibleText: "final",
    });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-a", "run-b"],
      rearmGeneration: 1,
      finalAssistantVisibleText: "replay",
    });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("rejects the wrong session or batch without consuming the owner", () => {
    const append = vi.fn(() => true);
    registerRequesterFinalAttachment({ ...base, append });
    promoteRequesterFinalAttachment({
      requesterAgentId: base.requesterAgentId,
      requesterSessionKey: base.requesterSessionKey,
      requesterTurnRunId: base.requesterTurnRunId,
      batchRunIds: ["run-a"],
      rearmGeneration: 2,
    });

    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      requesterSessionId: "session-other",
      batchRunIds: ["run-a"],
      rearmGeneration: 2,
      finalAssistantVisibleText: "wrong session",
    });
    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-b"],
      rearmGeneration: 2,
      finalAssistantVisibleText: "wrong batch",
    });
    expect(append).not.toHaveBeenCalled();
    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-a"],
      rearmGeneration: 2,
      finalAssistantVisibleText: "final",
    });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("replacement and lifecycle rotation revoke stale callbacks", () => {
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
      promoteRequesterFinalAttachment({
        requesterAgentId: base.requesterAgentId,
        requesterSessionKey: base.requesterSessionKey,
        requesterTurnRunId: "run-new",
        batchRunIds: ["run-new-child"],
        rearmGeneration: 1,
      }),
    ).toBe(true);

    lifecycle.generation = "generation-2";
    lifecycle.rotate?.(lifecycle.generation);
    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-new-child"],
      rearmGeneration: 1,
      finalAssistantVisibleText: "stale",
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("exact registration revocation cannot delete a newer replacement", () => {
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
      promoteRequesterFinalAttachment({
        requesterAgentId: base.requesterAgentId,
        requesterSessionKey: base.requesterSessionKey,
        requesterTurnRunId: "run-new",
        batchRunIds: ["run-new-child"],
        rearmGeneration: 3,
      }),
    ).toBe(true);
    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-new-child"],
      rearmGeneration: 3,
      finalAssistantVisibleText: "new final",
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("new final");
  });

  it("consumes a throwing callback without failing or replaying finalization", () => {
    const append = vi.fn(() => {
      throw new Error("socket closed");
    });
    registerRequesterFinalAttachment({
      ...base,
      append,
    });
    promoteRequesterFinalAttachment({
      requesterAgentId: base.requesterAgentId,
      requesterSessionKey: base.requesterSessionKey,
      requesterTurnRunId: base.requesterTurnRunId,
      batchRunIds: ["run-a"],
      rearmGeneration: 1,
    });

    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-a"],
      rearmGeneration: 1,
      finalAssistantVisibleText: "final",
    });
    finalizeRequesterFinalAttachment({
      ...deliveredFinal,
      batchRunIds: ["run-a"],
      rearmGeneration: 1,
      finalAssistantVisibleText: "replay",
    });
    expect(append).toHaveBeenCalledExactlyOnceWith("final");
  });

  it("drops an expired provisional attachment", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      registerRequesterFinalAttachment({ ...base, timeoutMs: 10, append: vi.fn(() => true) });
      vi.setSystemTime(1_011);
      expect(
        promoteRequesterFinalAttachment({
          requesterAgentId: base.requesterAgentId,
          requesterSessionKey: base.requesterSessionKey,
          requesterTurnRunId: base.requesterTurnRunId,
          batchRunIds: ["run-a"],
          rearmGeneration: 1,
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
