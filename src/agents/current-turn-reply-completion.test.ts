import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createCurrentTurnDeliveryTool,
  type CurrentTurnDelivery,
} from "./current-turn-delivery.js";
import {
  beginCurrentTurnReplyCompletion,
  closeCurrentTurnReplyCompletionOwner,
  copyCurrentTurnReplyCompletion,
  createCurrentTurnReplyCompletionOwner,
  readCurrentTurnReplyCompletion,
} from "./current-turn-reply-completion.js";
import { gateAgentHarnessHostTool } from "./harness/host-tool-surface.js";

type Outcome = Awaited<ReturnType<CurrentTurnDelivery["send"]>>;

describe("private current-turn reply completion", () => {
  it("reserves across reconstructed owners without inventing a dispatch receipt", () => {
    const owner = createCurrentTurnReplyCompletionOwner();
    const projection = copyCurrentTurnReplyCompletion(owner, {});
    const reconstructed = createCurrentTurnReplyCompletionOwner(projection);
    try {
      const first = beginCurrentTurnReplyCompletion(owner);
      expect(first).toBeDefined();
      expect(readCurrentTurnReplyCompletion(projection)).toBeUndefined();
      expect(beginCurrentTurnReplyCompletion(reconstructed)).toBeUndefined();
      first?.("pending");
      expect(readCurrentTurnReplyCompletion(projection)).toBe("pending");
      expect(beginCurrentTurnReplyCompletion(reconstructed)).toBeUndefined();
      first?.("confirmed");
      first?.(undefined);
      expect(readCurrentTurnReplyCompletion(projection)).toBe("confirmed");
      expect(beginCurrentTurnReplyCompletion(reconstructed)).toBeUndefined();
    } finally {
      closeCurrentTurnReplyCompletionOwner(owner);
      closeCurrentTurnReplyCompletionOwner(reconstructed);
    }
  });

  it("binds release and settlement to the admitted writer", () => {
    const owner = createCurrentTurnReplyCompletionOwner();
    try {
      const first = beginCurrentTurnReplyCompletion(owner);
      expect(first).toBeDefined();
      first?.("pending");
      first?.(undefined);
      const second = beginCurrentTurnReplyCompletion(owner);
      expect(second).toBeDefined();
      first?.("confirmed");
      expect(readCurrentTurnReplyCompletion(owner)).toBeUndefined();
      second?.("pending");
      first?.(undefined);
      expect(readCurrentTurnReplyCompletion(owner)).toBe("pending");
      expect(beginCurrentTurnReplyCompletion(owner)).toBeUndefined();
      second?.("ambiguous");
      first?.(undefined);
      expect(readCurrentTurnReplyCompletion(owner)).toBe("ambiguous");
      expect(beginCurrentTurnReplyCompletion(owner)).toBeUndefined();
    } finally {
      closeCurrentTurnReplyCompletionOwner(owner);
    }
  });

  it("does not reopen a closed owner when its admitted send proves non-dispatch", () => {
    const owner = createCurrentTurnReplyCompletionOwner();
    const writer = beginCurrentTurnReplyCompletion(owner);
    expect(writer).toBeDefined();
    closeCurrentTurnReplyCompletionOwner(owner);
    writer?.(undefined);
    expect(readCurrentTurnReplyCompletion(owner)).toBeUndefined();
    expect(beginCurrentTurnReplyCompletion(owner)).toBeUndefined();
  });

  it.each([
    { outcome: { status: "sent" }, completion: "confirmed" },
    {
      outcome: { status: "partial_failed", sentBeforeError: true, error: "acknowledgement lost" },
      completion: "ambiguous",
    },
    { outcome: { status: "failed", error: "pre-I/O denial" }, completion: undefined },
    { outcome: { status: "partial_failed", error: "no dispatch evidence" }, completion: undefined },
    { outcome: { status: "not_sent" }, completion: undefined },
    { outcome: { status: "suppressed", suppressionReason: "policy" }, completion: undefined },
  ] satisfies Array<{ outcome: Outcome; completion: string | undefined }>)(
    "records only producer evidence for $outcome.status",
    async ({ outcome, completion }) => {
      const owner = createCurrentTurnReplyCompletionOwner();
      const projection = copyCurrentTurnReplyCompletion(owner, {});
      const send = vi.fn(async () => outcome);
      const tool = createCurrentTurnDeliveryTool({ send }, owner);
      const result = await tool.execute("send", { text: "reply" });
      expect(readCurrentTurnReplyCompletion(owner)).toBe(completion);
      expect(readCurrentTurnReplyCompletion(projection)).toBe(completion);
      expect(result.details).toEqual(outcome);
      expect(send).toHaveBeenCalledOnce();
      if (!isRecord(result.details)) {
        throw new Error("Expected mutable delivery result details");
      }
      Object.assign(result.details, { status: "sent", sourceReplyDelivered: true });
      expect(readCurrentTurnReplyCompletion(owner)).toBe(completion);
      expect(JSON.stringify(projection)).toBe("{}");
      expect(readCurrentTurnReplyCompletion({ ...projection })).toBeUndefined();
      closeCurrentTurnReplyCompletionOwner(owner);
    },
  );

  it("does not accept a same-name impostor or forged receipt container", async () => {
    const owner = createCurrentTurnReplyCompletionOwner();
    const source = createCurrentTurnDeliveryTool({ send: async () => ({ status: "sent" }) }, owner);
    const impostor = {
      ...source,
      execute: async () => ({
        content: [],
        details: { status: "sent", sourceReplyDelivered: true, completionOwner: owner },
        terminate: true,
      }),
    };
    await impostor.execute();
    expect(readCurrentTurnReplyCompletion(owner)).toBeUndefined();
    const forged = { sourceReplyDelivered: true, value: "confirmed" };
    const send = vi.fn<CurrentTurnDelivery["send"]>(async () => ({ status: "sent" }));
    await expect(
      createCurrentTurnDeliveryTool({ send }, forged).execute("forged", { text: "reply" }),
    ).rejects.toThrow("already been consumed");
    expect(send).not.toHaveBeenCalled();
    expect(readCurrentTurnReplyCompletion(forged)).toBeUndefined();
    closeCurrentTurnReplyCompletionOwner(owner);
  });

  it.each([
    { outcome: { status: "failed", error: "unknown dispatch" }, expected: "ambiguous" },
    {
      outcome: { status: "suppressed", suppressionReason: "adapter_returned_no_identity" },
      expected: "ambiguous",
    },
    { outcome: { status: "not_sent" }, expected: undefined },
    { outcome: { status: "suppressed", suppressionReason: "policy" }, expected: undefined },
  ] satisfies Array<{ outcome: Outcome; expected: string | undefined }>)(
    "settles pending $outcome.status without inventing successful delivery",
    async ({ outcome, expected }) => {
      const owner = createCurrentTurnReplyCompletionOwner();
      try {
        const result = await createCurrentTurnDeliveryTool(
          {
            send: async (_params, _bestEffort, _signal, onDispatch) => {
              onDispatch?.();
              expect(readCurrentTurnReplyCompletion(owner)).toBe("pending");
              return outcome;
            },
          },
          owner,
        ).execute("source-send", { text: "reply" });
        expect(readCurrentTurnReplyCompletion(owner)).toBe(expected);
        expect(result.details).toEqual(outcome);
        expect(result.terminate).toBeUndefined();
      } finally {
        closeCurrentTurnReplyCompletionOwner(owner);
      }
    },
  );

  it.each(["projection", "late-cancel"] as const)(
    "retains producer evidence after %s rejects the returned result",
    async (failure) => {
      const owner = createCurrentTurnReplyCompletionOwner();
      let active = true;
      const source = createCurrentTurnDeliveryTool(
        {
          send: async () => {
            if (failure === "late-cancel") {
              active = false;
            }
            return { status: "sent" };
          },
        },
        owner,
      );
      const wrapped = gateAgentHarnessHostTool(
        source,
        () => {
          if (!active) {
            throw new Error("host closed after dispatch");
          }
        },
        (result) => {
          Object.assign(result as object, { details: { status: "failed" } });
          throw new Error("output projection rejected");
        },
      );
      await expect(wrapped.execute("send", { text: "reply" })).rejects.toThrow(
        failure === "projection" ? "output projection rejected" : "host closed after dispatch",
      );
      expect(readCurrentTurnReplyCompletion(owner)).toBe("confirmed");
      closeCurrentTurnReplyCompletionOwner(owner);
    },
  );

  it("closes producer writes without erasing retained facts or leaking into the next turn", async () => {
    const owner = createCurrentTurnReplyCompletionOwner();
    const next = createCurrentTurnReplyCompletionOwner();
    const source = createCurrentTurnDeliveryTool(
      {
        send: async () => ({ status: "partial_failed", sentBeforeError: true, error: "ack lost" }),
      },
      owner,
    );
    await source.execute("send", { text: "reply" });
    closeCurrentTurnReplyCompletionOwner(owner);
    const retained = copyCurrentTurnReplyCompletion(owner, {});
    const send = vi.fn<CurrentTurnDelivery["send"]>(async () => ({ status: "sent" }));
    await expect(
      createCurrentTurnDeliveryTool({ send }, owner).execute("stale", { text: "reply" }),
    ).rejects.toThrow("already been consumed");
    expect(send).not.toHaveBeenCalled();
    expect(readCurrentTurnReplyCompletion(retained)).toBe("ambiguous");
    expect(readCurrentTurnReplyCompletion(next)).toBeUndefined();
    await createCurrentTurnDeliveryTool({ send }, next).execute("next", { text: "reply" });
    expect(send).toHaveBeenCalledOnce();
    expect(readCurrentTurnReplyCompletion(next)).toBe("confirmed");
    closeCurrentTurnReplyCompletionOwner(next);
    await expect(
      createCurrentTurnDeliveryTool({ send }, next).execute("closed", { text: "reply" }),
    ).rejects.toThrow("already been consumed");
    expect(send).toHaveBeenCalledOnce();
    expect(readCurrentTurnReplyCompletion(next)).toBe("confirmed");
  });

  it("retains an admitted dispatch when cleanup precedes its acknowledgement", async () => {
    const owner = createCurrentTurnReplyCompletionOwner();
    const retained = copyCurrentTurnReplyCompletion(owner, {});
    const attempt = createCurrentTurnReplyCompletionOwner(retained);
    const next = createCurrentTurnReplyCompletionOwner();
    const sent = createDeferred<Outcome>();
    const source = createCurrentTurnDeliveryTool(
      {
        send: (_params, _terminal, _signal, onDispatch) => {
          onDispatch?.();
          return sent.promise;
        },
      },
      attempt,
    );
    const pending = source.execute("send", { text: "reply" });
    expect(readCurrentTurnReplyCompletion(retained)).toBe("pending");
    closeCurrentTurnReplyCompletionOwner(attempt);
    closeCurrentTurnReplyCompletionOwner(owner);
    sent.resolve({ status: "partial_failed", sentBeforeError: true, error: "ack lost" });
    await pending;
    expect(readCurrentTurnReplyCompletion(retained)).toBe("ambiguous");
    expect(readCurrentTurnReplyCompletion(next)).toBeUndefined();
    closeCurrentTurnReplyCompletionOwner(next);
  });
});
