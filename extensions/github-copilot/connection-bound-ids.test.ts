// Github Copilot tests cover connection-bound response replay.
import { describe, expect, it } from "vitest";
import { rewriteCopilotResponsePayloadConnectionBoundIds } from "./connection-bound-ids.js";

function rewriteInputIds(input: unknown): boolean {
  return rewriteCopilotResponsePayloadConnectionBoundIds({ input });
}

describe("github-copilot connection-bound response replay", () => {
  it("rewrites opaque message response item IDs deterministically", () => {
    const originalId = Buffer.from(`message-${"x".repeat(24)}`).toString("base64");
    const first = [{ id: originalId, type: "message" }];
    const second = [{ id: originalId, type: "message" }];

    expect(rewriteInputIds(first)).toBe(true);
    expect(rewriteInputIds(second)).toBe(true);
    expect(first[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("uses response item type prefixes and preserves local IDs", () => {
    const functionCallId = Buffer.from(`function-call-${"y".repeat(20)}`).toString("base64");
    const messageId = Buffer.from(`message-${"z".repeat(24)}`).toString("base64");
    const input = [
      {
        id: "rs_existing",
        type: "reasoning",
        encrypted_content: "ciphertext",
        summary: [],
      },
      { id: "msg_existing", type: "message" },
      { id: "fc_existing", type: "function_call" },
      { id: functionCallId, type: "function_call" },
      { id: messageId, type: "message" },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input.map((item) => item.id)).toEqual([
      "rs_existing",
      "msg_existing",
      "fc_existing",
      expect.stringMatching(/^fc_[a-f0-9]{16}$/),
      expect.stringMatching(/^msg_[a-f0-9]{16}$/),
    ]);
  });

  it("keeps complete reasoning and normalizes long Copilot IDs to idless", () => {
    const longId = Buffer.from(`reasoning-${"x".repeat(320)}`).toString("base64");
    const input = [
      { id: "rs_exact", type: "reasoning", encrypted_content: "exact", summary: [] },
      { id: longId, type: "reasoning", encrypted_content: "long", summary: [] },
      { type: "reasoning", encrypted_content: "idless", summary: [] },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input).toEqual([
      { id: "rs_exact", type: "reasoning", encrypted_content: "exact", summary: [] },
      { type: "reasoning", encrypted_content: "long", summary: [] },
      { type: "reasoning", encrypted_content: "idless", summary: [] },
    ]);
  });

  it("drops incomplete or foreign reasoning and its paired assistant message id", () => {
    const input = [
      { id: "rs_missing", type: "reasoning", summary: [] },
      {
        id: "msg_requires_reasoning",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible" }],
      },
      {
        id: "thinking_0",
        type: "reasoning",
        encrypted_content: "foreign",
        summary: [],
      },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible" }],
      },
    ]);
  });

  it("drops foreign base64-ish reasoning IDs", () => {
    const input = [
      {
        id: "abcDEF0123+/=",
        type: "reasoning",
        encrypted_content: "ciphertext",
        summary: [],
      },
      {
        id: "reasoning/abc+123=",
        type: "reasoning",
        encrypted_content: "ciphertext",
        summary: [],
      },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input).toEqual([]);
  });

  it("drops oversized native reasoning ids and their paired assistant message ids", () => {
    const input = [
      {
        id: `rs_${"x".repeat(62)}`,
        type: "reasoning",
        encrypted_content: "ciphertext",
        summary: [],
      },
      {
        id: "msg_requires_reasoning",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible" }],
      },
    ];

    expect(rewriteInputIds(input)).toBe(true);
    expect(input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "visible" }],
      },
    ]);
  });

  it("patches response payload input arrays only", () => {
    const messageId = Buffer.from(`message-${"m".repeat(24)}`).toString("base64");
    const payload = { input: [{ id: messageId, type: "message" }] };

    expect(rewriteCopilotResponsePayloadConnectionBoundIds(payload)).toBe(true);
    expect(payload.input[0]?.id).toMatch(/^msg_[a-f0-9]{16}$/);
    expect(rewriteCopilotResponsePayloadConnectionBoundIds(undefined)).toBe(false);
    expect(rewriteCopilotResponsePayloadConnectionBoundIds({ input: "text" })).toBe(false);
  });
});
