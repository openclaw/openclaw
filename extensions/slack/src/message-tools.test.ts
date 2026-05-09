import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";

describe("Slack message tools", () => {
  it("describes configured Slack message actions without loading channel runtime", () => {
    expect(
      describeSlackMessageTool({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
            },
          },
        },
      }),
    ).toMatchObject({
      actions: expect.arrayContaining(["send", "upload-file", "read"]),
      capabilities: expect.arrayContaining(["presentation"]),
    });
  });

  it("honors account-scoped action gates", () => {
    expect(
      describeSlackMessageTool({
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-default",
              accounts: {
                ops: {
                  botToken: "xoxb-ops",
                  actions: {
                    messages: false,
                  },
                },
              },
            },
          },
        },
        accountId: "ops",
      }).actions,
    ).not.toContain("upload-file");
  });

  it("includes file actions when message actions are enabled", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          actions: {
            messages: true,
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toEqual(
      expect.arrayContaining(["read", "edit", "delete", "download-file", "upload-file"]),
    );
  });

  it("advertises advanced Slack actions only when opted in", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          userToken: "xoxp-test",
          actions: {
            search: true,
            channelInfo: true,
            channels: true,
            files: true,
            scheduledMessages: true,
            ephemeralMessages: true,
            bookmarks: true,
            reminders: true,
            canvases: true,
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toEqual(
      expect.arrayContaining([
        "search",
        "channel-info",
        "channel-list",
        "file-list",
        "file-delete",
        "schedule-message",
        "scheduled-list",
        "delete-scheduled",
        "post-ephemeral",
        "bookmark-add",
        "reminder-add",
        "canvas-create",
        "channel-canvas-create",
      ]),
    );
  });

  it("does not advertise Slack search without a user token", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          actions: {
            search: true,
            channelInfo: true,
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).not.toContain("search");
    expect(listSlackMessageActions(cfg)).toContain("channel-info");
  });

  it("advertises Slack search for account-scoped user tokens", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-root",
          actions: { search: true },
          accounts: {
            botOnly: {
              botToken: "xoxb-bot",
              actions: { search: true },
            },
            work: {
              botToken: "xoxb-work",
              userToken: "xoxp-work",
              actions: { search: true },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg, "botOnly")).not.toContain("search");
    expect(listSlackMessageActions(cfg, "work")).toContain("search");
  });

  it("honors the selected Slack account during discovery", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-root",
          actions: {
            reactions: false,
            messages: false,
            pins: false,
            memberInfo: false,
            emojiList: false,
          },
          accounts: {
            default: {
              botToken: "xoxb-default",
              actions: {
                reactions: false,
                messages: false,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
            },
            work: {
              botToken: "xoxb-work",
              actions: {
                reactions: true,
                messages: true,
                pins: false,
                memberInfo: false,
                emojiList: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg, "default")).toEqual(["send"]);
    expect(listSlackMessageActions(cfg, "work")).toEqual([
      "send",
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "get-permalink",
      "download-file",
      "upload-file",
    ]);
  });
});
