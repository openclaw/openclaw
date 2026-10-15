// Verifies trusted middleware composition, native content adaptation, and failure presentation.
import { describe, expect, it } from "vitest";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

describe("createAgentToolResultMiddlewareRunner", () => {
  it("delivers tool result unchanged when no middleware is registered", async () => {
    const client: Record<string, unknown> = { type: "fake-channel-client" };
    const cyclicDetails: Record<string, unknown> = {
      ok: true,
      messageId: "abc",
      delete: () => Promise.resolve(),
      client,
    };
    client.message = cyclicDetails;
    const original = {
      content: [{ type: "text" as const, text: "delivered" }],
      details: cyclicDetails,
    };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: original,
    });

    expect(result).toBe(original);
  });

  it("adapts incoming nested toolResult content before middleware", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);
    const client: Record<string, unknown> = {};
    const details = {
      status: "sent",
      messageId: "msg_123",
      client,
      delete: () => Promise.resolve(),
    };
    client.message = details;

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "sent message id msg_123" },
              { type: "text", text: "status delivered" },
            ],
          } as never,
        ],
        details,
      },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "sent message id msg_123\nstatus delivered",
      },
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
              content: {
                message: "message delivered",
                id: "msg_456",
              },
            } as never,
          ],
          details: { status: "sent" },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "message delivered" }]);
    expect(result.details).toEqual({ status: "sent" });
  });

  it("bounds nested toolResult content before flattening", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              ...Array.from({ length: 200 }, () => ({
                type: "text",
                text: "x".repeat(600),
              })),
              { type: "text", text: "late chunk" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected flattened text content");
    }
    expect(content.text.length).toBeLessThanOrEqual(100_000);
    expect(content.text).not.toContain("late chunk");
  });

  it("preserves interleaved nested text and image order", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              {
                type: "tool_result",
                content: [
                  { type: "text", text: "first caption" },
                  { type: "image", mimeType: "image/png", data: "image-one" },
                  { type: "text", text: "second caption" },
                  { type: "image", mimeType: "image/png", data: "image-two" },
                ],
              },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "first caption" },
      { type: "image", mimeType: "image/png", data: "image-one" },
      { type: "text", text: "second caption" },
      { type: "image", mimeType: "image/png", data: "image-two" },
    ]);
  });

  it("fails closed instead of recursing forever on cyclic nested content", async () => {
    const nested: Record<string, unknown> = {
      type: "toolResult",
      content: [],
    };
    nested.content = [nested];
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [nested as never],
        details: {},
      },
    });

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

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: { action: "send", target: "C123" },
      result: {
        content: [{ type: "text", text: "raw result must stay private" }],
        details: {
          ok: true,
          result: { messageId: "1700000000.000100", channelId: "C123" },
          raw: "x".repeat(200_000),
        },
      },
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "Message delivered, but result post-processing failed." }],
      details: {
        ok: true,
        deliveryStatus: "sent",
        middlewareWarning: "post-processing failed",
      },
    });
  });

  it.each([
    ["plugin without ID", "message", { status: "sent" }, false, false],
    ["core sent without ID", "conversations_send", { status: "sent" }, false, true],
    [
      "core queued with ID",
      "conversations_send",
      { status: "queued", messageId: "prepared-1" },
      false,
      false,
    ],
    [
      "core sent with error",
      "conversations_turn",
      { status: "sent", error: "reply waiter unavailable" },
      false,
      false,
    ],
    [
      "core reply timeout",
      "conversations_turn",
      { status: "timeout", messageId: "sent-1" },
      false,
      false,
    ],
  ] satisfies Array<[string, string, Record<string, unknown>, boolean, boolean]>)(
    "preserves only confirmed successful delivery for %s after middleware failure",
    async (_name, toolName, details, isError, delivered) => {
      const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
        () => ({
          result: {
            content: [{ type: "text", text: "post-processing failed" }],
            details: { status: "error", middlewareError: true },
          },
        }),
      ]);

      const result = await runner.applyToolResultMiddleware({
        toolCallId: "call-1",
        toolName,
        isError,
        args: { action: "send", target: "C123" },
        result: {
          content: [{ type: "text", text: "raw result must stay private" }],
          details,
        },
      });

      expect(result).toEqual(
        delivered
          ? {
              content: [
                { type: "text", text: "Message delivered, but result post-processing failed." },
              ],
              details: {
                ok: true,
                deliveryStatus: "sent",
                middlewareWarning: "post-processing failed",
              },
            }
          : {
              content: [{ type: "text", text: "post-processing failed" }],
              details: { status: "error", middlewareError: true },
            },
      );
    },
  );
});
