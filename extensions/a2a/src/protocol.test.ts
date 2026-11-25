import { describe, expect, it } from "vitest";
import { extractA2aMessageText, resolveA2aRpcMethod } from "./protocol.js";

describe("A2A protocol message parts", () => {
  it("extracts structured data alongside text", () => {
    expect(extractA2aMessageText([{ text: "hello" }, { data: { count: 2, ready: true } }])).toBe(
      'hello\n{"count":2,"ready":true}',
    );
  });

  it("caps extracted UTF-8 text at 64 KiB without a leading BOM or split code point", () => {
    const text = extractA2aMessageText([{ text: "\uFEFF" + "🦞".repeat(20_000) }]);

    expect(text).toBeDefined();
    expect(Buffer.byteLength(text!)).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain("[message truncated at 65536 bytes]");
    expect(text).not.toContain("�");
    expect(text).not.toContain("\uFEFF");
  });
});

describe("A2A JSON-RPC request contracts", () => {
  it("does not resolve inherited Object methods", () => {
    expect(resolveA2aRpcMethod("constructor")).toBeUndefined();
  });
});
