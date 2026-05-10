import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { listSlackMessageActions } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";

function requireSchemaProperty(
  discovery: ReturnType<typeof describeSlackMessageTool>,
  property: string,
) {
  const schemas = Array.isArray(discovery.schema)
    ? discovery.schema
    : discovery.schema
      ? [discovery.schema]
      : [];
  const schema = schemas.find((entry) => property in entry.properties);
  if (!schema) {
    throw new Error(`Missing schema property ${property}`);
  }
  return {
    schema,
    property: schema.properties[property] as { description?: string },
  };
}

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

  it("describes Slack file ids separately from message ids", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    const { schema, property } = requireSchemaProperty(discovery, "fileId");

    expect(schema.actions).toEqual(["download-file"]);
    expect(property.description).toMatch(/Slack file id/i);
    expect(property.description).toContain("F0B0LTT8M36");
    expect(property.description).toContain("event.files[].id");
    expect(property.description).toMatch(/not the Slack message timestamp\/messageId/i);
  });

  it("describes current Slack message id actions without stale aliases", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
    });

    const { schema, property } = requireSchemaProperty(discovery, "messageId");
    const alias = schema.properties.message_id as { description?: string };

    expect(schema.actions).toEqual(["react", "reactions", "edit", "delete", "pin", "unpin"]);
    expect(schema.actions).not.toContain("unsend");
    expect(property.description).toContain("1777423717.666499");
    expect(property.description).toMatch(/Not used by download-file/i);
    expect(alias.description).toMatch(/Alias for messageId/i);
  });

  it("omits Slack file and message id schemas when those actions are disabled", () => {
    const discovery = describeSlackMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            actions: {
              reactions: false,
              messages: false,
              pins: false,
              memberInfo: false,
              emojiList: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery.actions).toEqual(["send"]);
    expect(discovery.schema).toBeNull();
  });
});
