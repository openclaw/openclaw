import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  hasExplicitFeishuGroupConfig,
  resolveFeishuGroupSenderActivationIngressAccess,
  resolveFeishuGroupToolPolicy,
  resolveFeishuReplyPolicy,
} from "./policy.js";
import { setFeishuRuntime } from "./runtime.js";

beforeEach(() => {
  setFeishuRuntime(createPluginRuntimeMock());
});

function createCfg(feishu: Record<string, unknown>): OpenClawConfig {
  return { channels: { feishu } } as OpenClawConfig;
}

function replyPolicy(feishu: Record<string, unknown>) {
  return resolveFeishuReplyPolicy({
    isDirectMessage: false,
    cfg: createCfg({ groupPolicy: "open", ...feishu }),
    groupPolicy: "open",
    groupId: "oc_1",
  });
}

describe("resolveFeishuReplyPolicy", () => {
  it.each([
    [{}, false],
    [{ requireMention: true }, true],
    [{ groups: { oc_1: { requireMention: true } } }, true],
  ])("resolves open-group mention policy %j", (config, requireMention) => {
    expect(replyPolicy(config)).toEqual({ requireMention });
  });
});

describe("resolveFeishuGroupToolPolicy", () => {
  it("keeps wildcard fields hidden by a matched whole group entry", () => {
    const cfg = createCfg({
      groups: {
        "*": { tools: { allow: ["wildcard"] } },
        OC_EXACT: { requireMention: true },
      },
    });

    expect(resolveFeishuGroupToolPolicy({ cfg, groupId: "oc_exact" })).toBeUndefined();
    expect(resolveFeishuGroupToolPolicy({ cfg, groupId: "oc_missing" })).toEqual({
      allow: ["wildcard"],
    });
  });
});

describe("hasExplicitFeishuGroupConfig", () => {
  it("matches direct and case-insensitive group ids", () => {
    const cfg = FeishuConfigSchema.parse({ groups: { OC_UPPER: { requireMention: true } } });

    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "OC_UPPER" })).toBe(true);
    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "oc_upper" })).toBe(true);
  });
});

describe("resolveFeishuGroupSenderActivationIngressAccess", () => {
  async function senderDecision(allowFrom: string[], senderOpenId: string, senderUserId?: string) {
    return (
      await resolveFeishuGroupSenderActivationIngressAccess({
        cfg: createCfg({}),
        accountId: "default",
        chatId: "oc_group",
        allowFrom,
        senderOpenId,
        senderUserId,
        requireMention: false,
        mentionedBot: true,
      })
    ).senderAccess.decision;
  }

  it("keeps user and chat allowlist namespaces distinct", async () => {
    await expect(senderDecision(["user:oc_group_123"], "oc_group_123")).resolves.toBe("block");
  });

  it("supports user_id as an additional immutable sender candidate", async () => {
    await expect(senderDecision(["on_user_123"], "ou_other", "on_user_123")).resolves.toBe("allow");
  });
});
