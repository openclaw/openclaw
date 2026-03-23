import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import { vkPlugin } from "./channel.js";

function requireResolveDmPolicy() {
  const resolveDmPolicy = vkPlugin.security?.resolveDmPolicy;
  if (!resolveDmPolicy) {
    throw new Error("vk security.resolveDmPolicy missing");
  }
  return resolveDmPolicy;
}

describe("vkPlugin", () => {
  it("has expected metadata", () => {
    expect(vkPlugin.id).toBe("vk");
    expect(vkPlugin.meta.label).toBe("VK");
    expect(vkPlugin.meta.docsPath).toBe("/channels/vk");
  });

  it("normalizes vk-prefixed targets", () => {
    expect(vkPlugin.messaging?.normalizeTarget?.("  vk:12345  ")).toBe("12345");
    expect(vkPlugin.pairing?.normalizeAllowEntry?.("  vk:67890  ")).toBe("67890");
  });

  it("recognizes numeric targets", () => {
    const looksLikeId = vkPlugin.messaging?.targetResolver?.looksLikeId;
    if (!looksLikeId) {
      throw new Error("vk messaging.targetResolver.looksLikeId missing");
    }
    expect(looksLikeId("12345")).toBe(true);
    expect(looksLikeId("group:2000000001")).toBe(true);
    expect(looksLikeId("hello")).toBe(false);
  });

  it("describes dm policy normalization", () => {
    const cfg = {
      channels: {
        vk: {
          dmPolicy: "allowlist",
          allowFrom: ["  vk:12345  "],
          botToken: "vk-token",
        },
      },
    } as unknown as OpenClawConfig;
    const resolveDmPolicy = requireResolveDmPolicy();
    const account = vkPlugin.config.resolveAccount(cfg, "default");
    const result = resolveDmPolicy({ cfg, account });
    if (!result) {
      throw new Error("vk resolveDmPolicy returned null");
    }
    expect(result.policy).toBe("allowlist");
    expect(result.normalizeEntry?.("  vk:12345  ")).toBe("12345");
  });

  it("builds direct session routes for numeric ids", () => {
    const route = vkPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      accountId: "default",
      target: "12345",
    });
    expect(route).toEqual(
      expect.objectContaining({
        chatType: "direct",
        to: "vk:12345",
      }),
    );
  });
});
