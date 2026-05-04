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
      "download-file",
      "upload-file",
    ]);
  });

  it("adds search when any enabled Slack account has a user token", () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-root",
          actions: {
            messages: true,
          },
          accounts: {
            default: {
              botToken: "xoxb-default",
              userToken: "xoxp-default",
              actions: {
                messages: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toEqual(expect.arrayContaining(["search"]));
  });

  it("exposes only runnable Slack search for user-token-only accounts", () => {
    const cfg = {
      channels: {
        slack: {
          actions: {
            messages: true,
          },
          accounts: {
            default: {
              userToken: "xoxp-default",
              actions: {
                messages: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toEqual(["search"]);
  });

  it("does not advertise search when the selected account lacks a user token", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            botOnly: {
              botToken: "xoxb-bot",
              actions: {
                messages: true,
              },
            },
            searchOnly: {
              userToken: "xoxp-user",
              actions: {
                messages: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg, "botOnly")).not.toContain("search");
    expect(listSlackMessageActions(cfg, "searchOnly")).toEqual(["search"]);
  });

  it("gates search with runnable user-token accounts rather than bot-only accounts", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            botOnly: {
              botToken: "xoxb-bot",
              actions: {
                messages: false,
              },
            },
            searchOnly: {
              userToken: "xoxp-user",
              actions: {
                messages: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listSlackMessageActions(cfg)).toContain("search");
  });
});
