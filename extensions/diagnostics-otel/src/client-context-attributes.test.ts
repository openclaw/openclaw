import { describe, expect, it } from "vitest";
import { assignClientContextAttributes, clientContextKeys } from "./client-context-attributes.js";

describe("assignClientContextAttributes", () => {
  it("no-ops on undefined context", () => {
    const attrs: Record<string, string | number | boolean> = { "openclaw.model": "x" };
    assignClientContextAttributes(attrs, undefined);
    expect(attrs).toEqual({ "openclaw.model": "x" });
  });

  it("stamps scalar keys under openclaw.client.* with preserved types", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { agentId: "Conductor", turn: 3, root: true });
    expect(attrs).toEqual({
      "openclaw.client.agentId": "Conductor",
      "openclaw.client.turn": 3,
      "openclaw.client.root": true,
    });
  });

  it("skips null/undefined values", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { a: null, b: "keep" });
    expect(attrs).toEqual({ "openclaw.client.b": "keep" });
  });

  it("JSON-encodes nested values", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { meta: { region: "us", tags: [1, 2] } });
    expect(attrs["openclaw.client.meta"]).toBe('{"region":"us","tags":[1,2]}');
  });

  it("preserves pre-existing attributes", () => {
    const attrs: Record<string, string | number | boolean> = { "openclaw.provider": "anthropic" };
    assignClientContextAttributes(attrs, { agentId: "Conductor" });
    expect(attrs["openclaw.provider"]).toBe("anthropic");
    expect(attrs["openclaw.client.agentId"]).toBe("Conductor");
  });

  it("truncates oversized string values", () => {
    const attrs: Record<string, string | number | boolean> = {};
    assignClientContextAttributes(attrs, { big: "x".repeat(9000) });
    expect((attrs["openclaw.client.big"] as string).length).toBe(4096);
  });
});

describe("clientContextKeys", () => {
  it("returns sessionId then sessionKey, dropping absent fields", () => {
    expect(clientContextKeys({ sessionId: "sid", sessionKey: "skey" })).toEqual(["sid", "skey"]);
    expect(clientContextKeys({ sessionKey: "skey" })).toEqual(["skey"]);
    expect(clientContextKeys({})).toEqual([]);
  });
});
