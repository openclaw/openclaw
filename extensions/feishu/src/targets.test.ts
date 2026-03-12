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

  it("treats explicit group targets as chat_id", () => {
    expect(resolveReceiveIdType("group:oc_123")).toBe("chat_id");
  });

  it("treats explicit channel targets as chat_id", () => {
    expect(resolveReceiveIdType("channel:oc_123")).toBe("chat_id");
  });

  it("treats dm-prefixed open IDs as open_id", () => {
    expect(resolveReceiveIdType("dm:ou_123")).toBe("open_id");
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

  it("normalizes group/channel prefixes to chat ids", () => {
    expect(normalizeFeishuTarget("group:oc_123")).toBe("oc_123");
    expect(normalizeFeishuTarget("feishu:group:oc_123")).toBe("oc_123");
    expect(normalizeFeishuTarget("channel:oc_456")).toBe("oc_456");
    expect(normalizeFeishuTarget("lark:channel:oc_456")).toBe("oc_456");
  });

  it("accepts provider-prefixed raw ids", () => {
    expect(normalizeFeishuTarget("feishu:ou_123")).toBe("ou_123");
  });

  it("strips provider and dm prefixes", () => {
    expect(normalizeFeishuTarget("lark:dm:ou_123")).toBe("ou_123");
  });
});

describe("looksLikeFeishuId", () => {
  it("accepts provider-prefixed user targets", () => {
    expect(looksLikeFeishuId("feishu:user:ou_123")).toBe(true);
  });

  it("accepts provider-prefixed chat targets", () => {
    expect(looksLikeFeishuId("lark:chat:oc_123")).toBe(true);
  });

  it("accepts group/channel targets", () => {
    expect(looksLikeFeishuId("feishu:group:oc_123")).toBe(true);
    expect(looksLikeFeishuId("group:oc_123")).toBe(true);
    expect(looksLikeFeishuId("channel:oc_456")).toBe(true);
  });
});

describe("direct: prefix handling (OpenClaw internal peer format)", () => {
  it("normalizeFeishuTarget strips direct: prefix for ou_ ids", () => {
    expect(normalizeFeishuTarget("direct:ou_abc123")).toBe("ou_abc123");
  });

  it("normalizeFeishuTarget strips direct: prefix for oc_ ids", () => {
    expect(normalizeFeishuTarget("direct:oc_dm_chat")).toBe("oc_dm_chat");
  });

  it("normalizeFeishuTarget strips feishu:direct: compound prefix", () => {
    // Gateway passes targets as feishu:direct:ou_xxx from session key extraction
    expect(normalizeFeishuTarget("feishu:direct:ou_abc123")).toBe("ou_abc123");
    expect(normalizeFeishuTarget("lark:direct:ou_abc123")).toBe("ou_abc123");
    expect(normalizeFeishuTarget("feishu:direct:oc_dm_chat")).toBe("oc_dm_chat");
  });

  it("resolveReceiveIdType handles direct:ou_ as open_id", () => {
    expect(resolveReceiveIdType("direct:ou_abc123")).toBe("open_id");
  });

  it("resolveReceiveIdType handles direct:oc_ as chat_id", () => {
    expect(resolveReceiveIdType("direct:oc_dm_chat")).toBe("chat_id");
  });

  it("looksLikeFeishuId recognizes direct: prefix", () => {
    expect(looksLikeFeishuId("direct:ou_abc123")).toBe(true);
    expect(looksLikeFeishuId("direct:oc_chat123")).toBe(true);
  });
});
