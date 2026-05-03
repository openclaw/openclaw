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

  describe("download-file / messageId schema contributions (Friday-2026-04-29 regression guard)", () => {
    // The 2026-04-29 production failure was the LLM confusing messageId
    // (Slack message timestamp) with fileId (Slack F… id) on download-file.
    // The model only sees field documentation we provide via the schema
    // contribution, so these tests pin both the presence of the fragments
    // and the explicit anti-confusion language.
    const baseCfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          actions: {
            messages: true,
            reactions: true,
            pins: true,
          },
        },
      },
    } as OpenClawConfig;

    it("contributes a fileId schema fragment scoped to download-file", () => {
      const discovery = describeSlackMessageTool({ cfg: baseCfg });
      expect(discovery.schema).not.toBeNull();
      const contributions = Array.isArray(discovery.schema)
        ? discovery.schema
        : discovery.schema
          ? [discovery.schema]
          : [];
      const fileIdFragment = contributions.find((c) => c.properties && "fileId" in c.properties);
      expect(fileIdFragment).toBeDefined();
      expect(fileIdFragment?.actions).toEqual(["download-file"]);
      // The actual model-visible description must spell out the
      // fileId-vs-messageId distinction.
      const fileIdDesc = (fileIdFragment?.properties.fileId as { description?: string } | undefined)
        ?.description;
      expect(fileIdDesc).toMatch(/Slack file id/i);
      expect(fileIdDesc).toMatch(/F0B0LTT8M36|starts with "F"|F…/i);
      expect(fileIdDesc).toMatch(/event\.files\[\]\.id/);
      expect(fileIdDesc).toMatch(/NOT.*messageId|not.*messageId/);
    });

    it("contributes a messageId schema fragment scoped to react/edit/delete/pin/unpin", () => {
      const discovery = describeSlackMessageTool({ cfg: baseCfg });
      const contributions = Array.isArray(discovery.schema)
        ? discovery.schema
        : discovery.schema
          ? [discovery.schema]
          : [];
      const messageIdFragment = contributions.find(
        (c) => c.properties && "messageId" in c.properties,
      );
      expect(messageIdFragment).toBeDefined();
      expect(messageIdFragment?.actions).toEqual(
        expect.arrayContaining(["react", "reactions", "edit", "delete", "pin", "unpin"]),
      );
      // The messageId description must call out that download-file does
      // NOT use this field — cross-referencing the two is the whole point.
      const messageIdDesc = (
        messageIdFragment?.properties.messageId as { description?: string } | undefined
      )?.description;
      expect(messageIdDesc).toMatch(/Slack message timestamp/i);
      expect(messageIdDesc).toMatch(/NOT.*download-file|not.*download-file/);
      // Snake_case alias should also be present.
      expect(messageIdFragment?.properties.message_id).toBeDefined();
    });

    it("omits the fileId fragment when the account has no download-file access", () => {
      const cfg = {
        channels: {
          slack: {
            botToken: "xoxb-test",
            actions: {
              // Disable everything that gates download-file via the
              // 'messages' family.
              messages: false,
              reactions: false,
              pins: false,
            },
          },
        },
      } as OpenClawConfig;
      const discovery = describeSlackMessageTool({ cfg });
      const contributions = Array.isArray(discovery.schema)
        ? discovery.schema
        : discovery.schema
          ? [discovery.schema]
          : [];
      const fileIdFragment = contributions.find((c) => c.properties && "fileId" in c.properties);
      expect(fileIdFragment).toBeUndefined();
    });
  });
});
