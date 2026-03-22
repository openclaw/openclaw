import { describe, expect, it } from "vitest";
import { isFeishuGroupChat } from "./chat-type.js";

describe("isFeishuGroupChat", () => {
  it("returns true for chat_type='group' regardless of chat_id prefix", () => {
    expect(isFeishuGroupChat("group", "oc_abc123")).toBe(true);
    expect(isFeishuGroupChat("group", "g_abc123")).toBe(true);
    expect(isFeishuGroupChat("group", "p2p_abc123")).toBe(true);
  });

  it("returns false for chat_type='p2p' with a non-oc_ chat_id (real DM)", () => {
    expect(isFeishuGroupChat("p2p", "p2p_abc123")).toBe(false);
    expect(isFeishuGroupChat("p2p", "")).toBe(false);
    expect(isFeishuGroupChat("p2p", "ou_abc123")).toBe(false);
  });

  it("returns true for chat_type='p2p' with an oc_ chat_id (Feishu OpenChat / topic group)", () => {
    // Reproduces: https://github.com/openclaw/openclaw/issues/52238
    // Real-world log: "received message from ou_... in oc_ceaacf99d602be4842fe4505a77a4e70 (p2p)"
    expect(isFeishuGroupChat("p2p", "oc_ceaacf99d602be4842fe4505a77a4e70")).toBe(true);
    expect(isFeishuGroupChat("p2p", "oc_abc123")).toBe(true);
  });

  it("returns false for chat_type='private'", () => {
    expect(isFeishuGroupChat("private", "oc_abc123")).toBe(false);
    expect(isFeishuGroupChat("private", "p2p_abc123")).toBe(false);
  });
});
