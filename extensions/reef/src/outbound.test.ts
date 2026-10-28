import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalBytes, PipelineError, REEF_MAX_PLAINTEXT_BYTES } from "../protocol/index.js";
import { ReefMessageFlow } from "./flow.js";
import { allow, createFlow, resetFlowStoresForTests } from "./flow.test-helpers.js";
import { reefMessageAdapter, reefOutboundAdapter } from "./outbound.js";
import { createReefRuntimeAuthority, getActiveReef } from "./runtime.js";

function createDispatchingFlowSend(afterDispatch: () => string) {
  return vi.fn(
    async (
      _peer: string,
      _text: string,
      context: { onPlatformSendDispatch?: () => Promise<void> },
    ) => {
      await context.onPlatformSendDispatch?.();
      return afterDispatch();
    },
  );
}

const message = { cfg: {}, to: "reef:Alice", text: "hello" };
const messageId = "01JZ0000000000000000000200";
const replyToId = "01JZ0000000000000000000199";

afterEach(resetFlowStoresForTests);

describe("reefOutboundAdapter", () => {
  it("removes internal tool text while preserving user-visible examples", () => {
    const sanitize = (text: string) =>
      reefOutboundAdapter.sanitizeText!({ text, payload: { text } });
    const fenced = ["```xml", '<tool_call>{"name":"exec"}</tool_call>', "```"].join("\n");

    expect(sanitize("Done.\n⚠️ 🛠️ `search repos (agent)` failed")).toBe("Done.");
    expect(sanitize('<tool_call>{"name":"exec"}</tool_call>Message sent.')).toBe("Message sent.");
    expect(sanitize(fenced)).toBe(fenced);
  });

  it.each(["outbound", "message"] as const)(
    "normalizes and marks %s dispatch before I/O",
    async (adapter) => {
      const order: string[] = [];
      const send = createDispatchingFlowSend(() => {
        order.push("send");
        return messageId;
      });
      createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);
      const params = {
        ...message,
        accountId: "default",
        threadId: 42,
        replyToId,
        preparedMessageId: messageId,
        onPlatformSendDispatch: async () => {
          order.push("dispatch");
        },
      };
      const result = await (adapter === "outbound"
        ? reefOutboundAdapter.sendText!(params as never)
        : reefMessageAdapter.send.text(params));
      if (adapter === "outbound") {
        expect(result).toEqual({
          channel: "reef",
          messageId,
          target: { kind: "chat", id: "alice" },
          toJid: "reef:alice",
        });
      } else {
        expect(result).toMatchObject({ messageId });
      }
      expect(order).toEqual(["dispatch", "send"]);
      expect(send).toHaveBeenCalledWith("alice", "hello", {
        thread: "42",
        replyTo: replyToId,
        messageId,
        onPlatformSendDispatch: expect.any(Function),
      });
    },
  );

  it("revokes a borrowed encrypted flow before a paused guard reaches the replaced relay", async () => {
    const guardEntered = createDeferred<void>();
    const guardPaused = createDeferred<void>();
    const firstAuthority = createReefRuntimeAuthority();
    const { flow: original, classifier, relay } = await createFlow();
    classifier.classify.mockImplementation(async () => {
      guardEntered.resolve();
      await guardPaused.promise;
      return allow;
    });
    const flow = new ReefMessageFlow({
      ...original.options,
      authoritySignal: firstAuthority.signal,
    });
    firstAuthority.activate({ flow, friends: {}, reviews: {} } as never);
    const stale = reefMessageAdapter.send.text({ cfg: {}, to: "reef:alice", text: "stale" });
    await Promise.race([guardEntered.promise, stale]);
    expect(classifier.classify).toHaveBeenCalledOnce();

    const replacementAuthority = createReefRuntimeAuthority();
    const replacement = { flow: {}, friends: {}, reviews: {} } as never;
    replacementAuthority.activate(replacement);
    try {
      guardPaused.resolve();
      const staleResult = await stale.catch((error: unknown) => error);

      expect(relay.sendEnvelope).not.toHaveBeenCalled();
      expect(staleResult).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(getActiveReef()).toBe(replacement);
    } finally {
      replacementAuthority.release();
      firstAuthority.release();
    }
  });

  it("terminally rejects unapproved Reef peers", async () => {
    const { flow, trusted } = await createFlow();
    await trusted.remove("alice");
    createReefRuntimeAuthority().activate({ flow, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send.text(message).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      cause: {
        name: "ReefOutboundRejectedError",
        message: expect.stringContaining("not approved"),
      },
      retryable: false,
    });
  });

  it("keeps guard availability failures retryable before dispatch", async () => {
    const cause = new PipelineError("guard", "guard unavailable", {
      ...allow,
      decision: "deny",
      category: "guard_failure",
    });
    const send = vi.fn(async () => {
      throw cause;
    });
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send.text(message).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ cause, retryable: true });
  });

  it("keeps published dispatch ambiguous when account authority closes", async () => {
    const cause = new Error("relay outcome unknown");
    const authority = createReefRuntimeAuthority();
    const send = createDispatchingFlowSend(() => {
      throw cause;
    });
    const onPlatformSendDispatch = vi.fn(async () => authority.release());
    authority.activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefMessageAdapter.send
      .text({
        ...message,
        onPlatformSendDispatch,
      })
      .catch((caught: unknown) => caught);

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(error).toBe(cause);
  });

  it("prepares a protocol-valid id without requiring an active Gateway runtime", () => {
    expect(reefOutboundAdapter.prepareConversationTurnMessageId!(message)).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
  });

  it("permanently rejects correlated text enlarged after its initial preflight", async () => {
    const rawText = "x".repeat(REEF_MAX_PLAINTEXT_BYTES - 256);
    const preparedMessageId = reefOutboundAdapter.prepareConversationTurnMessageId!({
      ...message,
      text: rawText,
    });
    const send = vi.fn(async () => messageId);
    createReefRuntimeAuthority().activate({ flow: { send }, friends: {}, reviews: {} } as never);

    const error = await reefOutboundAdapter.sendText!({
      ...message,
      accountId: "default",
      text: `${"p".repeat(512)} ${rawText}`,
      preparedMessageId,
    } as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({
      message: expect.stringContaining("atomic message limit"),
      retryable: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("chunks ordinary text by canonical plaintext bytes", () => {
    const text = `${"a".repeat(40_000)}${"🦞".repeat(10_000)}`;
    const chunks = reefOutboundAdapter.chunker!(text, REEF_MAX_PLAINTEXT_BYTES);

    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(
        canonicalBytes({
          text: chunk,
          replyTo: "0".repeat(26),
          thread: "0".repeat(26),
        }).length,
      ).toBeLessThanOrEqual(REEF_MAX_PLAINTEXT_BYTES);
    }
  });
});
