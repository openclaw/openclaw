import { describe, expect, it } from "vitest";
import {
  A2aRpcRequestSchema,
  A2aSendMessageParamsSchema,
  A2aTaskRequestParamsSchema,
  extractA2aMessageText,
  resolveA2aRpcMethod,
} from "./protocol.js";

describe("A2A protocol message parts", () => {
  it.each([
    { description: "v1 text", parts: [{ text: "hello" }], expected: "hello" },
    { description: "legacy kind", parts: [{ kind: "text", text: "hello" }], expected: "hello" },
    { description: "legacy type", parts: [{ type: "text", text: "hello" }], expected: "hello" },
    {
      description: "structured data",
      parts: [{ text: "hello" }, { data: { count: 2, ready: true } }],
      expected: 'hello\n{"count":2,"ready":true}',
    },
    { description: "null data", parts: [{ data: null }], expected: "null" },
    {
      description: "file parts only",
      parts: [{ url: "https://example.test/file" }],
      expected: undefined,
    },
    { description: "raw parts only", parts: [{ raw: "aGVsbG8=" }], expected: undefined },
    { description: "blank text", parts: [{ text: "  \n" }], expected: undefined },
  ])("extracts $description", ({ parts, expected }) => {
    expect(extractA2aMessageText(parts)).toBe(expected);
  });

  it.each(["", "\uFEFF"])("caps extracted UTF-8 text with prefix %j at 64 KiB", (prefix) => {
    const text = extractA2aMessageText([{ text: prefix + "🦞".repeat(20_000) }]);

    expect(text).toBeDefined();
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain("[message truncated at 65536 bytes]");
    expect(text).not.toContain("�");
    expect(text).not.toContain("\uFEFF");
  });
});

describe("A2A JSON-RPC request contracts", () => {
  it.each([
    ["SendMessage", "SendMessage"],
    ["GetTask", "GetTask"],
    ["CancelTask", "unsupported"],
    ["message/send", "SendMessage"],
    ["tasks/get", "GetTask"],
    ["tasks/cancel", "unsupported"],
    ["SendStreamingMessage", "unsupported"],
    ["ListTasks", "unsupported"],
    ["tasks/send", undefined],
    ["constructor", undefined],
  ] as const)("routes %s to %s", (method, expected) => {
    expect(resolveA2aRpcMethod(method)).toBe(expected);
  });

  it("accepts notifications and rejects invalid JSON-RPC envelopes", () => {
    expect(A2aRpcRequestSchema.safeParse({ jsonrpc: "2.0", method: "GetTask" }).success).toBe(true);
    expect(A2aRpcRequestSchema.safeParse({ jsonrpc: "1.0", method: "GetTask" }).success).toBe(
      false,
    );
    expect(
      A2aRpcRequestSchema.safeParse({ jsonrpc: "2.0", id: {}, method: "GetTask" }).success,
    ).toBe(false);
  });

  it("accepts generated-message-id requests but requires role and parts", () => {
    expect(
      A2aSendMessageParamsSchema.safeParse({ message: { role: "user", parts: [{ text: "hi" }] } })
        .success,
    ).toBe(true);
    expect(A2aSendMessageParamsSchema.safeParse({ message: { role: "user" } }).success).toBe(false);
    expect(A2aSendMessageParamsSchema.safeParse({ message: { parts: [] } }).success).toBe(false);
    expect(
      A2aSendMessageParamsSchema.safeParse({ message: { role: "operator", parts: [] } }).success,
    ).toBe(false);
  });

  it.each([
    ["ctx-openclaw:peer_1.2", true],
    ["../escape", false],
    ["a".repeat(129), false],
  ])("validates conversation identifier %s", (contextId, valid) => {
    expect(
      A2aSendMessageParamsSchema.safeParse({
        message: { role: "ROLE_USER", contextId, parts: [{ text: "hi" }] },
      }).success,
    ).toBe(valid);
  });

  it("requires a nonempty task identifier", () => {
    expect(A2aTaskRequestParamsSchema.safeParse({ id: "task-1", historyLength: 2 }).success).toBe(
      true,
    );
    expect(A2aTaskRequestParamsSchema.safeParse({ id: "" }).success).toBe(false);
    expect(A2aTaskRequestParamsSchema.safeParse({ id: "task-1", historyLength: -1 }).success).toBe(
      false,
    );
  });
});
