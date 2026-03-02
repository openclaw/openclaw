import { describe, expect, it } from "vitest";
import { looksLikeFeishuId, normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";

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

describe("normalizeFeishuTarget", () => {
  it("strips provider and user prefixes", () => {
    expect(normalizeFeishuTarget("feishu:user:ou_123")).toBe("ou_123");
    expect(normalizeFeishuTarget("lark:user:ou_123")).toBe("ou_123");
  });

  it("strips provider and chat prefixes", () => {
    expect(normalizeFeishuTarget("feishu:chat:oc_123")).toBe("oc_123");
  });

  it("accepts provider-prefixed raw ids", () => {
    expect(normalizeFeishuTarget("feishu:ou_123")).toBe("ou_123");
  });

  it("strips group: prefix to bare chat id", () => {
    expect(normalizeFeishuTarget("group:oc_524f00307b58bc1da7bbd046afed326f")).toBe(
      "oc_524f00307b58bc1da7bbd046afed326f",
    );
  });

  it("strips dm: prefix to bare user id", () => {
    expect(normalizeFeishuTarget("dm:ou_abc123")).toBe("ou_abc123");
  });
});

describe("looksLikeFeishuId", () => {
  it("accepts provider-prefixed user targets", () => {
    expect(looksLikeFeishuId("feishu:user:ou_123")).toBe(true);
  });

  it("accepts provider-prefixed chat targets", () => {
    expect(looksLikeFeishuId("lark:chat:oc_123")).toBe(true);
  });
});
