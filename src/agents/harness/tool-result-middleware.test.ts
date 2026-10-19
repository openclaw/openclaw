import { describe, expect, it } from "vitest";
import type {
  AgentToolResultMiddlewareEvent,
  OpenClawAgentToolResult,
} from "../../plugins/agent-tool-result-middleware-types.js";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

type Runner = ReturnType<typeof createAgentToolResultMiddlewareRunner>;
function apply(
  runner: Runner,
  result: OpenClawAgentToolResult,
  event: Partial<Omit<AgentToolResultMiddlewareEvent, "result">> = {},
) {
  return runner.applyToolResultMiddleware({
    toolCallId: "call-1",
    toolName: "message",
    args: {},
    ...event,
    result,
  });
}
function applyNative(
  block: OpenClawAgentToolResult["content"][number],
  details: unknown = {},
  toolName = "message",
) {
  const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);
  return apply(runner, resultOf([block], details), { toolName });
}
function resultOf(
  content: OpenClawAgentToolResult["content"],
  details: unknown = {},
): OpenClawAgentToolResult {
  return { content, details };
}
function nativeContent(content: unknown) {
  return { type: "toolResult", toolUseId: "call-1", content };
}
function cyclicDetails(fields: Record<string, unknown>) {
  const client: Record<string, unknown> = {};
  const details = { ...fields, client, delete: () => Promise.resolve() };
  client.message = details;
  return details;
}
const deliveryFailure = {
  content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
  details: { ok: true, deliveryStatus: "sent", middlewareWarning: "post-processing failed" },
};

describe("createAgentToolResultMiddlewareRunner", () => {
  it("delivers tool result unchanged when no middleware is registered", async () => {
    const original = resultOf(
      [{ type: "text", text: "delivered" }],
      cyclicDetails({ ok: true, messageId: "abc" }),
    );
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    expect(await apply(runner, original)).toBe(original);
  });

  it("adapts incoming nested toolResult content before middleware", async () => {
    const details = cyclicDetails({ status: "sent", messageId: "msg_123" });

    const result = await applyNative(
      nativeContent([
        { type: "text", text: "sent message id msg_123" },
        { type: "text", text: "status delivered" },
      ]) as never,
      details,
    );

    expect(result.content).toEqual([
      { type: "text", text: "sent message id msg_123\nstatus delivered" },
    ]);
    expect(result.details).toBe(details);
  });

  it("coerces nested tool_result blocks returned by middleware", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [
            {
              type: "tool_result",
              content: { message: "message delivered", id: "msg_456" },
            } as never,
          ],
          details: { status: "sent" },
        },
      }),
    ]);

    const result = await apply(runner, { content: [{ type: "text", text: "raw" }], details: {} });

    expect(result.content).toEqual([{ type: "text", text: "message delivered" }]);
    expect(result.details).toEqual({ status: "sent" });
  });

  it("bounds nested toolResult content before flattening", async () => {
    const result = await applyNative(
      nativeContent([
        ...Array.from({ length: 200 }, () => ({
          type: "text",
          text: "x".repeat(600),
        })),
        { type: "text", text: "late chunk" },
      ]) as never,
    );

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected flattened text content");
    }
    expect(content.text.length).toBeLessThanOrEqual(100_000);
    expect(content.text).not.toContain("late chunk");
  });

  it("preserves interleaved nested text and image order", async () => {
    const result = await applyNative(
      nativeContent([
        {
          type: "tool_result",
          content: [
            { type: "text", text: "first caption" },
            { type: "image", mimeType: "image/png", data: "image-one" },
            { type: "text", text: "second caption" },
            { type: "image", mimeType: "image/png", data: "image-two" },
          ],
        },
      ]) as never,
      {},
      "screenshot",
    );

    expect(result.content).toEqual([
      { type: "text", text: "first caption" },
      { type: "image", mimeType: "image/png", data: "image-one" },
      { type: "text", text: "second caption" },
      { type: "image", mimeType: "image/png", data: "image-two" },
    ]);
  });

  it("fails closed instead of recursing forever on cyclic nested content", async () => {
    const nested: Record<string, unknown> = { type: "toolResult", content: [] };
    nested.content = [nested];

    const result = await applyNative(nested as never);

    expect(result).toEqual({
      content: [{ type: "text", text: "Tool output unavailable due to post-processing error." }],
      details: { status: "error", middlewareError: true },
    });
  });

  it("snapshots confirmed delivery before a middleware failure", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => {
        throw new Error("post-processing failed");
      },
    ]);

    const result = await apply(
      runner,
      {
        content: [{ type: "text", text: "raw result must stay private" }],
        details: {
          ok: true,
          result: { messageId: "1700000000.000100", channelId: "C123" },
          raw: "x".repeat(200_000),
        },
      },
      { args: { action: "send", target: "C123" } },
    );

    expect(result).toEqual(deliveryFailure);
  });

  it.each([
    ["plugin without ID", "message", { status: "sent" }, false],
    ["core sent without ID", "conversations_send", { status: "sent" }, true],
    [
      "core queued with ID",
      "conversations_send",
      { status: "queued", messageId: "prepared-1" },
      false,
    ],
    [
      "core sent with error",
      "conversations_turn",
      { status: "sent", error: "reply waiter unavailable" },
      false,
    ],
    ["core reply timeout", "conversations_turn", { status: "timeout", messageId: "sent-1" }, false],
  ] satisfies Array<[string, string, Record<string, unknown>, boolean]>)(
    "preserves only confirmed successful delivery for %s after middleware failure",
    async (_name, toolName, details, delivered) => {
      const failure = resultOf([{ type: "text", text: "post-processing failed" }], {
        status: "error",
        middlewareError: true,
      });
      const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
        () => ({ result: structuredClone(failure) }),
      ]);

      const result = await apply(
        runner,
        {
          content: [{ type: "text", text: "raw result must stay private" }],
          details,
        },
        { toolName, isError: false, args: { action: "send", target: "C123" } },
      );

      expect(result).toEqual(delivered ? deliveryFailure : failure);
    },
  );
});
