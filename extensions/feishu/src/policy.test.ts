// Feishu tests cover policy plugin behavior.
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
import type { FeishuConfig } from "./types.js";

beforeEach(() => {
  setFeishuRuntime(createPluginRuntimeMock());
});

function createCfg(feishu: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      feishu,
    },
  } as OpenClawConfig;
}

function createFeishuConfig(overrides: Partial<FeishuConfig>): FeishuConfig {
  return FeishuConfigSchema.parse(overrides);
}

describe("resolveFeishuReplyPolicy", () => {
  it("defaults open groups to no mention when unset", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "open" }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: false });
  });

  it("keeps explicit top-level mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "open", requireMention: true }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("keeps explicit account mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({
          groupPolicy: "allowlist",
          requireMention: false,
          accounts: {
            work: {
              groupPolicy: "open",
              requireMention: true,
            },
          },
        }),
        accountId: "work",
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("keeps explicit per-group mention gating in open groups", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({
          groupPolicy: "open",
          groups: { oc_1: { requireMention: true } },
        }),
        groupPolicy: "open",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });

  it("defaults allowlist groups to require mentions", () => {
    expect(
      resolveFeishuReplyPolicy({
        isDirectMessage: false,
        cfg: createCfg({ groupPolicy: "allowlist" }),
        groupPolicy: "allowlist",
        groupId: "oc_1",
      }),
    ).toEqual({ requireMention: true });
  });
});

describe("resolveFeishuGroupToolPolicy", () => {
  it("checks exact keys before the case-insensitive scan", () => {
    expect(
      resolveFeishuGroupToolPolicy({
        cfg: createCfg({
          groups: {
            OC_CASE: { tools: { allow: ["case-insensitive"] } },
            oc_case: { tools: { allow: ["exact"] } },
          },
        }),
        groupId: "oc_case",
      }),
    ).toEqual({ allow: ["exact"] });
  });

  it("keeps wildcard fields hidden by a matched whole group entry", () => {
    const cfg = createCfg({
      groups: {
        "*": { tools: { allow: ["wildcard"] } },
        OC_EXACT: { requireMention: true },
      },
    });

    expect(
      resolveFeishuGroupToolPolicy({
        cfg,
        groupId: "oc_exact",
      }),
    ).toBeUndefined();
    expect(resolveFeishuGroupToolPolicy({ cfg, groupId: "oc_missing" })).toEqual({
      allow: ["wildcard"],
    });
  });

  it("keeps account groups out of the root-only adapter", () => {
    expect(
      resolveFeishuGroupToolPolicy({
        cfg: createCfg({
          accounts: {
            work: {
              groups: {
                oc_account: { tools: { allow: ["account"] } },
              },
            },
          },
        }),
        accountId: "work",
        groupId: "oc_account",
      }),
    ).toBeUndefined();
  });
});

describe("hasExplicitFeishuGroupConfig", () => {
  it("matches direct and case-insensitive group ids", () => {
    const cfg = createFeishuConfig({
      groups: {
        OC_UPPER: { requireMention: true },
      },
    });

    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "OC_UPPER" })).toBe(true);
    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "oc_upper" })).toBe(true);
  });

  it("does not treat wildcard group defaults as explicit admission", () => {
    const cfg = createFeishuConfig({
      groups: {
        "*": { requireMention: false },
      },
    });

    expect(hasExplicitFeishuGroupConfig({ cfg, groupId: "oc_any" })).toBe(false);
  });
});

describe("resolveFeishuGroupSenderActivationIngressAccess", () => {
  async function senderDecision(params: {
    allowFrom: Array<string | number>;
    senderOpenId: string;
    senderUserId?: string;
  }) {
    return (
      await resolveFeishuGroupSenderActivationIngressAccess({
        cfg: createCfg({}),
        accountId: "default",
        chatId: "oc_group",
        allowFrom: params.allowFrom,
        senderOpenId: params.senderOpenId,
        senderUserId: params.senderUserId,
        requireMention: false,
        mentionedBot: true,
      })
    ).senderAccess.decision;
  }

  it("allows provider-prefixed wildcard entries", async () => {
    await expect(
      senderDecision({
        allowFrom: ["feishu:*", "lark:*"],
        senderOpenId: "ou_anyone",
      }),
    ).resolves.toBe("allow");
  });

  it("matches normalized immutable user ID entries", async () => {
    await expect(
      senderDecision({
        allowFrom: ["feishu:feishu:user:ou_ALLOWED"],
        senderOpenId: "ou_ALLOWED",
      }),
    ).resolves.toBe("allow");
  });

  it("keeps user and chat allowlist namespaces distinct", async () => {
    await expect(
      senderDecision({
        allowFrom: ["user:oc_group_123"],
        senderOpenId: "oc_group_123",
      }),
    ).resolves.toBe("block");
  });

  it("supports user_id as an additional immutable sender candidate", async () => {
    await expect(
      senderDecision({
        allowFrom: ["on_user_123"],
        senderOpenId: "ou_other",
        senderUserId: "on_user_123",
      }),
    ).resolves.toBe("allow");
  });
});
