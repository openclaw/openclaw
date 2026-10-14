import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { msteamsPlugin } from "./channel.js";

describe("msteamsPlugin.threading.resolveAutoThreadId", () => {
  function resolveAutoThreadId(params: {
    cfg?: OpenClawConfig;
    accountId?: string;
    to?: string;
    currentGraphChannelId?: string;
  }) {
    const resolve = msteamsPlugin.threading?.resolveAutoThreadId;
    if (!resolve) {
      throw new Error("msteams threading.resolveAutoThreadId unavailable");
    }
    return resolve({
      cfg: params.cfg ?? ({} as OpenClawConfig),
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

  it("returns undefined for a global top-level reply style", () => {
    expect(
      resolveAutoThreadId({
        cfg: { channels: { msteams: { replyStyle: "top-level" } } } as OpenClawConfig,
      }),
    ).toBeUndefined();
  });

  it("honors a named account top-level reply style", () => {
    expect(
      resolveAutoThreadId({
        accountId: "ops",
        cfg: {
          channels: {
            msteams: {
              replyStyle: "thread",
              accounts: { ops: { replyStyle: "top-level" } },
            },
          },
        } as OpenClawConfig,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when requireMention defaults the reply style to top-level", () => {
    expect(
      resolveAutoThreadId({
        cfg: { channels: { msteams: { requireMention: false } } } as OpenClawConfig,
      }),
    ).toBeUndefined();
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
});
