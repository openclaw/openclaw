// Codex tests cover sandbox exec-server JSON-RPC parser behavior.
import { describe, expect, it } from "vitest";
import { parseRequest, requireObject, requireString } from "./json-rpc.js";

describe("parseRequest", () => {
  it("throws descriptive error on malformed JSON", () => {
    expect(() => parseRequest(Buffer.from("NOT JSON {{{"))).toThrow(
      "JSON-RPC request body is not valid JSON.",
    );
  });

  it("throws descriptive error on empty data", () => {
    expect(() => parseRequest(Buffer.from(""))).toThrow("JSON-RPC request body is not valid JSON.");
  });

  it("parses a valid JSON-RPC request", () => {
    const result = parseRequest(
      Buffer.from(
        JSON.stringify({
          method: "tools/call",
          params: { name: "test", arguments: {} },
          id: 1,
        }),
      ),
    );
    expect(result.method).toBe("tools/call");
    expect(result.id).toBe(1);
  });

  it("throws requireObject error for non-object valid JSON", () => {
    expect(() => parseRequest(Buffer.from("[1,2,3]"))).toThrow(
      "JSON-RPC request must be an object.",
    );
  });
});

describe("requireObject", () => {
  it("returns the value when it is a non-array object", () => {
    expect(requireObject({ key: "val" }, "test")).toEqual({ key: "val" });
  });

  it("throws for null", () => {
    expect(() => requireObject(null, "test")).toThrow("test must be an object.");
  });

  it("throws for an array", () => {
    expect(() => requireObject([1, 2], "test")).toThrow("test must be an object.");
  });
});

describe("requireString", () => {
  it("returns the string when non-empty", () => {
    expect(requireString("hello", "param")).toBe("hello");
  });

  it("throws for empty string", () => {
    expect(() => requireString("", "param")).toThrow();
  });

  it("throws for non-string", () => {
    expect(() => requireString(123 as unknown as string, "param")).toThrow();
  });
});
