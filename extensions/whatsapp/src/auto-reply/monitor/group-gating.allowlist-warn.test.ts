import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import {
  resetGroupDropWarningsForTests,
  applyGroupGating,
  type GroupHistoryEntry,
} from "./group-gating.js";

function makeUnregisteredGroupMsg(
  conversationId: string,
  accountId: string = "default",
): WebInboundMsg {
  return {
    id: `msg-${conversationId}`,
    from: conversationId,
    to: "+15550000001",
    body: "@openclaw hello",
    chatId: conversationId,
    chatType: "group",
    conversationId,
    timestamp: 1700000000,
    accountId,
    sender: { e164: "+15550000002", name: "Alice" },
  } as WebInboundMsg;
}

type WarnLogger = (obj: unknown, msg: string) => void;

function makeParams(msg: WebInboundMsg, warn: WarnLogger) {
  return {
    cfg: {
      channels: {
        whatsapp: {
          groupPolicy: "allowlist",
          groups: {
            "registered@g.us": {},
          },
          accounts: {
            work: {
              groupPolicy: "allowlist",
              groups: {
                "registered@g.us": {},
              },
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\bopenclaw\\b"],
        },
      },
    } as never,
    msg,
    conversationId: msg.conversationId,
    groupHistoryKey: `whatsapp:group:${msg.conversationId}`,
    agentId: "main",
    sessionKey: `agent:main:whatsapp:group:${msg.conversationId}`,
    baseMentionConfig: { mentionRegexes: [/\bopenclaw\b/i] } satisfies MentionConfig,
    groupHistories: new Map<string, GroupHistoryEntry[]>(),
    groupHistoryLimit: 20,
    groupMemberNames: new Map<string, Map<string, string>>(),
    logVerbose: vi.fn(),
    replyLogger: { debug: vi.fn(), warn },
  };
}

describe("applyGroupGating allowlist drop warning", () => {
  beforeEach(() => {
    resetGroupDropWarningsForTests();
  });

  it("emits a warn log naming the root groups path for the default account", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("unregistered@g.us");

    const result = await applyGroupGating(makeParams(msg, warn));

    expect(result).toEqual({ shouldProcess: false });
    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      conversationId: "unregistered@g.us",
      accountId: "default",
      groupsPath: "channels.whatsapp.groups",
    });
    expect(message).toContain("unregistered@g.us");
    expect(message).toContain("channels.whatsapp.groups");
  });

  it("names the account-scoped groups path for non-default accounts", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("unregistered@g.us", "work");

    await applyGroupGating(makeParams(msg, warn));

    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      conversationId: "unregistered@g.us",
      accountId: "work",
      groupsPath: "channels.whatsapp.accounts.work.groups",
    });
    expect(message).toContain("channels.whatsapp.accounts.work.groups");
  });

  it("only warns once per conversation across repeated messages", async () => {
    const warn = vi.fn<WarnLogger>();

    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("loud@g.us"), warn));
    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("loud@g.us"), warn));
    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("loud@g.us"), warn));

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns separately for distinct conversations", async () => {
    const warn = vi.fn<WarnLogger>();

    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("a@g.us"), warn));
    await applyGroupGating(makeParams(makeUnregisteredGroupMsg("b@g.us"), warn));

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[1]).toContain("a@g.us");
    expect(warn.mock.calls[1]?.[1]).toContain("b@g.us");
  });

  it("does not warn when the group is registered", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("registered@g.us");

    await applyGroupGating(makeParams(msg, warn));

    expect(warn).not.toHaveBeenCalled();
  });
});
