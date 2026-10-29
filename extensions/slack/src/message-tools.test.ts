import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import {
  createDisabledSlackActions,
  createInvokeSpy,
  dispatch,
} from "./message-action-dispatch.test-support.js";
import { listSlackMessageActions } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";

const schemasFor = (discovery: ReturnType<typeof describeSlackMessageTool>) =>
  Array.isArray(discovery.schema) ? discovery.schema : discovery.schema ? [discovery.schema] : [];

function requireSchemaProperty(
  discovery: ReturnType<typeof describeSlackMessageTool>,
  property: string,
) {
  const schemas = schemasFor(discovery);
  const schema = schemas.find((entry) => property in entry.properties);
  if (!schema) {
    throw new Error(`Missing schema property ${property}`);
  }
  return {
    schema,
    property: schema.properties[property] as { description?: string },
  };
}

const configuredSlack: OpenClawConfig = {
  channels: { slack: { botToken: "xoxb-test", actions: { channels: true } } },
};

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

async function invokeAction(context: Omit<Parameters<typeof dispatch>[1], "channel" | "cfg">) {
  const invoke = createInvokeSpy();
  await dispatch(invoke, { channel: "slack", cfg: {}, ...context });
  return invoke;
}

function expectInvocation(
  invoke: ReturnType<typeof createInvokeSpy>,
  action: Record<string, unknown>,
  context?: Record<string, unknown>,
) {
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining(action),
    expect.any(Object),
    context ? expect.objectContaining(context) : undefined,
  );
}

describe("Slack message tools", () => {
  it("forwards trusted current-conversation, requester-account, and action authority context", async () => {
    const assertDirectAdapterHandoff = vi.fn();
    const toolContext = {
      currentChannelProvider: "slack" as const,
      currentChannelId: "C_CURRENT",
    };

    const invoke = await invokeAction({
      action: "read",
      params: { channelId: "C_CURRENT" },
      requesterAccountId: "work",
      requesterSenderId: "U123",
      assertDirectAdapterHandoff,
      toolContext,
    });

    expectInvocation(
      invoke,
      { action: "readMessages", channelId: "C_CURRENT" },
      {
        currentChannelProvider: "slack",
        currentChannelId: "C_CURRENT",
        requesterAccountId: "work",
        requesterSenderId: "U123",
        assertDirectAdapterHandoff,
      },
    );
  });

  it("preserves a workspace-qualified channel for reactions", async () => {
    const invoke = await invokeAction({
      action: "react",
      params: {
        channelId: "team:T123:channel:C123",
        messageId: "123.456",
        emoji: "✅",
      },
    });

    expectInvocation(invoke, {
      action: "react",
      channelId: "team:T123:channel:C123",
    });
  });

  it("preserves a workspace-qualified channel for implicit upload destinations", async () => {
    const invoke = await invokeAction({
      action: "upload-file",
      params: {
        channelId: "team:T123:channel:C123",
        filePath: "/tmp/report.png",
      },
    });

    expectInvocation(invoke, {
      action: "uploadFile",
      to: "team:T123:channel:C123",
    });
  });

  it("classifies provider-native mutation actions", () => {
    const actions = createSlackActions("slack");
    for (const action of ["sendMessage", "editMessage", "deleteMessage", "pinMessage"]) {
      expect(actions.isToolDeliveryAction?.({ args: { action } })).toBe(true);
    }
    for (const action of ["readMessages", "listPins", "downloadFile"]) {
      expect(actions.isToolDeliveryAction?.({ args: { action } })).toBe(false);
    }
  });

  it("forwards complete trusted context for current-requester member info", async () => {
    const invoke = await invokeAction({
      action: "member-info",
      params: {},
      requesterAccountId: "default",
      requesterSenderId: "U123",
      conversationReadOrigin: "delegated",
      toolContext: { currentChannelProvider: "slack", currentChannelId: "C_CURRENT" },
    });

    expectInvocation(
      invoke,
      { action: "memberInfo", userId: "U123" },
      {
        currentChannelProvider: "slack",
        currentChannelId: "C_CURRENT",
        conversationReadOrigin: "delegated",
        requesterAccountId: "default",
        requesterSenderId: "U123",
      },
    );
  });

  it("does not accept Slack read authority from generic tool context", async () => {
    const invoke = await invokeAction({
      action: "read",
      params: { channelId: "C_CURRENT" },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "C_CURRENT",
        conversationReadOrigin: "direct-operator",
        requesterAccountId: "default",
        requesterSenderId: "U999",
        assertDirectAdapterHandoff: vi.fn(),
      } as never,
    });

    expectInvocation(
      invoke,
      { action: "readMessages", channelId: "C_CURRENT" },
      {
        currentChannelProvider: "slack",
        currentChannelId: "C_CURRENT",
        conversationReadOrigin: undefined,
        requesterAccountId: undefined,
        requesterSenderId: undefined,
        assertDirectAdapterHandoff: undefined,
      },
    );
  });

  it("describes configured Slack message actions without loading channel runtime", () => {
    const discovery = describeSlackMessageTool({ cfg: configuredSlack });

    expect(Object.keys(discovery).toSorted()).toEqual(["actions", "capabilities", "schema"]);
    // The complete default action inventory is owned by the channel-actions contract suite.
    expect(discovery.capabilities).toEqual(["presentation"]);
    expect(Array.isArray(discovery.schema)).toBe(true);
    const schemas = Array.isArray(discovery.schema) ? discovery.schema : [];
    expect(schemas.find((entry) => entry.actions?.includes("channel-create"))).toBeUndefined();
    expect(schemas.find((entry) => entry.actions?.includes("conversation-open"))).toMatchObject({
      actions: ["conversation-open"],
      visibility: "all-configured",
    });
    for (const propertyName of ["forceDocument", "asDocument"]) {
      const entries = schemas.filter((entry) => propertyName in entry.properties);
      expect(entries.map((entry) => entry.actions)).toEqual([["send"], ["upload-file"]]);
      for (const entry of entries) {
        const description = (entry.properties[propertyName] as { description?: string })
          .description;
        expect(description).toMatch(/preserve original image bytes/i);
        expect(description).toMatch(/without image optimization/i);
        expect(description).toMatch(/not.*Slack document/i);
      }
    }
  });

  it("honors account-scoped action gates", () => {
    expect(
      describeSlackMessageTool({
        cfg: slackConfig({
          botToken: "xoxb-default",
          accounts: {
            ops: {
              botToken: "xoxb-ops",
              actions: { messages: false },
            },
          },
        }),
        accountId: "ops",
      }).actions,
    ).not.toContain("upload-file");
  });

  it("exposes message actions for a configured user-identity account", () => {
    const cfg = slackConfig({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
    });

    expect(listSlackMessageActions(cfg)).toEqual([
      "send",
      "react",
      "reactions",
      "conversation-open",
      "read",
      "edit",
      "delete",
      "download-file",
      "upload-file",
      "pin",
      "unpin",
      "list-pins",
      "member-info",
      "emoji-list",
    ]);
  });

  it("honors the selected Slack account during discovery", () => {
    const cfg = slackConfig({
      botToken: "xoxb-root",
      actions: createDisabledSlackActions(),
      accounts: {
        default: {
          botToken: "xoxb-default",
          actions: createDisabledSlackActions(),
        },
        work: {
          botToken: "xoxb-work",
          actions: {
            channels: true,
            reactions: true,
            messages: true,
            pins: false,
            memberInfo: false,
            emojiList: false,
          },
        },
      },
    });

    expect(listSlackMessageActions(cfg, "default")).toEqual(["send"]);
    expect(listSlackMessageActions(cfg, "work")).toEqual([
      "send",
      "react",
      "reactions",
      "channel-create",
      "conversation-open",
      "read",
      "edit",
      "delete",
      "download-file",
      "upload-file",
    ]);
  });

  it.each([
    [
      "fileId",
      ["download-file"],
      [
        /Slack file id/i,
        /F0B0LTT8M36/,
        /event\.files\[\]\.id/,
        /not the Slack message timestamp\/messageId/i,
      ],
    ],
    [
      "messageId",
      ["react", "reactions", "edit", "delete", "pin", "unpin"],
      [
        /1777423717\.666499/,
        /React defaults to the current inbound message/i,
        /Not used by download-file/i,
      ],
    ],
    [
      "replyBroadcast",
      ["send"],
      [/action="send"/, /threadId/, /Not supported for media or upload-file/],
    ],
    ["topLevel", ["send"], [/action="send"/, /parent-channel/, /threadId: null/]],
  ] as const)("describes %s only for its supported actions", (name, actions, descriptions) => {
    const { schema, property } = requireSchemaProperty(
      describeSlackMessageTool({ cfg: configuredSlack }),
      name,
    );
    expect(schema.actions).toEqual(actions);
    for (const description of descriptions) {
      expect(property.description).toMatch(description);
    }
    if (name === "messageId") {
      expect(schema.properties.message_id).toMatchObject({
        description: expect.stringMatching(/Alias for messageId/i),
      });
    }
  });

  it.each([true, false])(
    "describes Slack custom emoji and advertises discovery only when enabled (%s)",
    (emojiList) => {
      const discovery = describeSlackMessageTool({
        cfg: slackConfig({
          botToken: "xoxb-test",
          actions: { emojiList },
        }),
      });

      const { schema, property } = requireSchemaProperty(discovery, "emoji");

      expect(schema.actions).toEqual(["react", "reactions"]);
      expect(property.description).toContain("white_check_mark");
      expect(property.description).toContain("✅");
      expect(property.description).toContain("workspace custom emoji");
      expect(property.description?.includes('action:"emoji-list"')).toBe(emojiList);
      expect(discovery.actions?.includes("emoji-list")).toBe(emojiList);
    },
  );

  it("omits the react emoji schema when reactions are disabled", () => {
    const discovery = describeSlackMessageTool({
      cfg: slackConfig({
        botToken: "xoxb-test",
        actions: { channels: false, reactions: false },
      }),
    });

    const schemas = schemasFor(discovery);
    const propertyNames = schemas.flatMap((entry) => Object.keys(entry.properties));
    expect(propertyNames).not.toContain("emoji");
  });

  it("omits Slack file and message id schemas when those actions are disabled", () => {
    const discovery = describeSlackMessageTool({
      cfg: slackConfig({
        botToken: "xoxb-test",
        actions: createDisabledSlackActions(),
      }),
    });

    expect(discovery.actions).toEqual(["send"]);
    const schemas = schemasFor(discovery);
    const propertyNames = schemas.flatMap((entry) => Object.keys(entry.properties));
    expect(propertyNames).not.toContain("fileId");
    expect(propertyNames).not.toContain("messageId");
    expect(propertyNames).toContain("replyBroadcast");
  });
});
