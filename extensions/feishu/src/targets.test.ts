import { describe, expect, it } from "vitest";
import { normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

describe("normalizeFeishuTarget", () => {
  it("strips group: prefix to extract chat_id", () => {
    expect(normalizeFeishuTarget("group:oc_524f00307b58bc1da7bbd046afed326f")).toBe(
      "oc_524f00307b58bc1da7bbd046afed326f",
    );
  });

  it("strips chat: prefix", () => {
    expect(normalizeFeishuTarget("chat:oc_abc123")).toBe("oc_abc123");
  });

  it("strips user: prefix", () => {
    expect(normalizeFeishuTarget("user:ou_abc123")).toBe("ou_abc123");
  });

  it("returns raw value when no prefix", () => {
    expect(normalizeFeishuTarget("oc_abc123")).toBe("oc_abc123");
  });

  it("returns null for empty string", () => {
    expect(normalizeFeishuTarget("")).toBeNull();
  });
});

describe("resolveReceiveIdType", () => {
  it("resolves chat IDs by oc_ prefix", () => {
    expect(resolveReceiveIdType("oc_123")).toBe("chat_id");
  });

  it("resolves open IDs by ou_ prefix", () => {
    expect(resolveReceiveIdType("ou_123")).toBe("open_id");
  });

  it("defaults unprefixed IDs to user_id", () => {
    expect(resolveReceiveIdType("u_123")).toBe("user_id");
  });
});
