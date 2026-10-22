import { describe, expect, it } from "vitest";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuTestConfig } from "./bot.test-support.js";
import { resolveFeishuChatType } from "./chat-type.js";
import {
  assertFeishuChatReadAllowed,
  canEnumerateAllFeishuGroups,
  canEnumerateAllFeishuPeers,
  resolveFeishuChatReadPreliminaryAuthorization,
} from "./read-policy.js";
import type { ResolvedFeishuAccount } from "./types.js";

const cfg = createFeishuTestConfig({});

function createAccount(
  config: Partial<ResolvedFeishuAccount["config"]> = {},
): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    domain: "feishu",
    config: {
      groupPolicy: "allowlist",
      dmPolicy: "pairing",
      ...config,
    } as ResolvedFeishuAccount["config"],
  };
}

type ReadParams = Parameters<typeof assertFeishuChatReadAllowed>[0];
const currentContext = {
  accountId: "default",
  requesterAccountId: "default",
  toolContext: { currentChannelProvider: "feishu", currentChannelId: "oc_current" },
};
function read(params: Pick<ReadParams, "account" | "chatId"> & Partial<ReadParams>) {
  return assertFeishuChatReadAllowed({ cfg, ctx: {}, ...params });
}
function expectDenied(params: Parameters<typeof read>[0]) {
  expect(() => read(params)).toThrow("Feishu read target is not allowed.");
}

describe("Feishu read policy", () => {
  it("does not derive conversation kind from public/private visibility", () => {
    expect(resolveFeishuChatType({ chat_type: "private" })).toBeUndefined();
    expect(resolveFeishuChatType({ chat_type: "public" })).toBeUndefined();
    expect(resolveFeishuChatType({ chat_type: "p2p" })).toBe("p2p");
    expect(resolveFeishuChatType({ chat_type: "group" })).toBe("group");
    expect(resolveFeishuChatType({ chat_mode: "group", chat_type: "private" })).toBe("group");
    expect(resolveFeishuChatType({ chat_mode: "p2p", chat_type: "private" })).toBe("p2p");
  });

  it("allows only the trusted current chat when the target type is unknown", () => {
    const account = createAccount();
    expect(read({ account, chatId: "oc_current", ctx: currentContext })).toBe("oc_current");
    expectDenied({ account, chatId: "oc_other", ctx: currentContext });
  });

  it("does not treat public delivery routing as trusted current-chat identity", () => {
    expectDenied({
      account: createAccount(),
      chatId: "oc_unconfigured",
      chatType: "group",
      ctx: {
        agentAccountId: "default",
        messageChannel: "feishu",
        deliveryContext: {
          channel: "feishu",
          to: "oc_unconfigured",
          accountId: "default",
        },
      },
    });
  });

  it.each([
    {
      name: "wildcard defaults are not admission",
      account: createAccount({ dmPolicy: "open", groups: { "*": { requireMention: false } } }),
      chatId: "oc_unconfigured",
    },
    {
      name: "disabled group policy blocks unclassified current targets",
      account: createAccount({ groupPolicy: "disabled" }),
      chatId: "oc_current",
      ctx: currentContext,
    },
    {
      name: "disabled group targets block direct operators",
      account: createAccount({ groups: { oc_blocked: { enabled: false } } }),
      chatId: "oc_blocked",
      chatType: "group",
      ctx: { conversationReadOrigin: "direct-operator" },
    },
  ] satisfies Array<Parameters<typeof read>[0] & { name: string }>)("$name", expectDenied);

  it("requires an effective wildcard before open policy allows non-current DMs", () => {
    const mergedCfg = createFeishuTestConfig({
      appId: "cli_test",
      appSecret: "secret_test",
      dmPolicy: "allowlist",
      allowFrom: ["ou_admin"],
      accounts: { sales: { dmPolicy: "open" } },
    });
    const account = resolveFeishuAccount({ cfg: mergedCfg, accountId: "sales" });

    const target = { cfg: mergedCfg, account, chatId: "oc_other", chatType: "p2p" } as const;
    expectDenied(target);
    expect(canEnumerateAllFeishuPeers(account)).toBe(false);

    account.config = { ...account.config, allowFrom: ["ou_admin", "feishu:*"] };
    expect(read(target)).toBe("oc_other");
    expect(canEnumerateAllFeishuPeers(account)).toBe(true);
  });

  it("honors wildcard group admission entries", () => {
    const account = createAccount({ groupAllowFrom: ["*"] });
    expect(read({ account, chatId: "oc_any", chatType: "group" })).toBe("oc_any");
    expect(canEnumerateAllFeishuGroups(cfg, account)).toBe(true);
  });

  it("requires metadata only when an unknown target has mixed scope policy", () => {
    const account = createAccount({ allowFrom: ["*"] });
    const target = { cfg, account, chatId: "oc_unknown" };
    const authorization = (ctx: ReadParams["ctx"]) =>
      resolveFeishuChatReadPreliminaryAuthorization({ ...target, ctx });
    expect(authorization({})).toEqual({ chatId: "oc_unknown", decision: "needs-metadata" });
    expect(authorization({ conversationReadOrigin: "direct-operator" })).toEqual({
      chatId: "oc_unknown",
      decision: "allow",
    });
  });
});
