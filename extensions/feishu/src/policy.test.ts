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

describe("Feishu policy", () => {
  it.each([
    [{}, false],
    [{ requireMention: true }, true],
    [{ groups: { oc_1: { requireMention: true } } }, true],
  ])("resolves open-group mention policy %j", (config, requireMention) => {
    expect(
      resolveFeishuReplyPolicy({
        cfg: createCfg({ groupPolicy: "open", ...config }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention });
  });
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
  it("matches direct and case-insensitive group ids", () => {
    const cfg = FeishuConfigSchema.parse({ groups: { OC_UPPER: { requireMention: true } } });

    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "OC_UPPER" })).toBe(true);
    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "oc_upper" })).toBe(true);
  });
  it.each([
    ["user:oc_group_123", "oc_group_123", undefined, "block"],
    ["on_user_123", "ou_other", "on_user_123", "allow"],
  ] as const)(
    "matches sender identities without crossing user/chat namespaces: %s",
    async (allowed, senderOpenId, senderUserId, decision) => {
      expect(
        (
          await resolveFeishuGroupSenderActivationIngressAccess({
            cfg: createCfg({}),
            accountId: "default",
            chatId: "oc_group",
            allowFrom: [allowed],
            senderOpenId,
            senderUserId,
            requireMention: false,
            mentionedBot: true,
          })
        ).senderAccess.decision,
      ).toBe(decision);
    },
  );
});
