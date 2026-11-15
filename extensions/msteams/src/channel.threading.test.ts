import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { msteamsPlugin } from "./channel.js";

describe("msteamsPlugin.threading.resolveAutoThreadId", () => {
  const conversation = "conversation:19:current@thread.tacv2";
  const context = {
    currentChannelId: conversation,
    currentThreadTs: "thread-root",
    replyToMode: "all" as const,
  };
  const autoThread = msteamsPlugin.threading!.resolveAutoThreadId!;

  function resolveAutoThreadId(params: {
    cfg?: OpenClawConfig;
    accountId?: string;
    to?: string;
    currentGraphChannelId?: string;
  }) {
    return autoThread({
      cfg: params.cfg ?? {},
      accountId: params.accountId,
      to: params.to ?? "conversation:19:channel@thread.tacv2",
      toolContext: {
        currentChannelId: "conversation:19:channel@thread.tacv2",
        currentMessagingTarget: params.currentGraphChannelId,
        currentGraphChannelId: params.currentGraphChannelId,
        currentThreadTs: "thread-root",
        replyToMode: "all",
      },
    });
  }

  it.each([
    ["global reply style", { replyStyle: "top-level" }, undefined],
    [
      "named account override",
      { replyStyle: "thread", accounts: { ops: { replyStyle: "top-level" } } },
      "ops",
    ],
    ["requireMention default", { requireMention: false }, undefined],
  ] as const)("does not auto-thread under top-level %s", (_name, msteams, accountId) => {
    expect(resolveAutoThreadId({ accountId, cfg: { channels: { msteams } } })).toBeUndefined();
  });

  it("honors team and channel reply style overrides", () => {
    const cfg = {
      channels: {
        msteams: {
          replyStyle: "thread",
          teams: {
            "team-1": {
              replyStyle: "top-level",
              channels: { "19:channel@thread.tacv2": { replyStyle: "thread" } },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAutoThreadId({ cfg, currentGraphChannelId: "team-1/19:other@thread.tacv2" }),
    ).toBeUndefined();
    expect(
      resolveAutoThreadId({ cfg, currentGraphChannelId: "team-1/19:channel@thread.tacv2" }),
    ).toBe("thread-root");
  });

  it("uses the inbound thread root instead of its quoted parent", () => {
    const toolContext = msteamsPlugin.threading!.buildToolContext!({
      cfg: {},
      context: {
        ChatType: "channel",
        To: conversation,
        MessageThreadId: "thread-root",
        ReplyToId: "parent",
      },
    });
    expect(autoThread({ cfg: {}, to: conversation, toolContext })).toBe("thread-root");
  });

  it("preserves an explicit thread under top-level reply style", () => {
    expect(
      autoThread({
        cfg: { channels: { msteams: { replyStyle: "top-level" } } },
        to: `${conversation};messageid=explicit-root`,
        toolContext: context,
      }),
    ).toBe("explicit-root");
  });

  it("does not borrow a thread from a different conversation", () => {
    expect(
      autoThread({ cfg: {}, to: "conversation:19:other@thread.tacv2", toolContext: context }),
    ).toBeUndefined();
  });

  it("does not invent a thread for a DM", () => {
    expect(
      autoThread({
        cfg: {},
        to: "user:aad-user-1",
        toolContext: { currentChannelId: "user:aad-user-1" },
      }),
    ).toBeUndefined();
  });
});
