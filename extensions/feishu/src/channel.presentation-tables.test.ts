// Feishu tests cover presentation card table modes on the action surface.
import {
  convertMarkdownTables,
  type MarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendStickerFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const editMessageFeishuMock = vi.hoisted(() => vi.fn());
const createPinFeishuMock = vi.hoisted(() => vi.fn());
const listPinsFeishuMock = vi.hoisted(() => vi.fn());
const removePinFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const getChatMembersMock = vi.hoisted(() => vi.fn());
const buildFeishuDirectChatMembersMock = vi.hoisted(() =>
  vi.fn(
    (authorization: { chatId: string; memberId: string; memberIdType: "open_id" | "user_id" }) => ({
      chat_id: authorization.chatId,
      has_more: false,
      page_token: undefined,
      members: [
        {
          member_id: authorization.memberId,
          name: undefined,
          tenant_key: undefined,
          member_id_type: authorization.memberIdType,
        },
      ],
    }),
  ),
);
const assertFeishuChatMemberMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryPeersLiveMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryGroupsLiveMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendTextMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendMediaMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendPayloadMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    createPinFeishu: createPinFeishuMock,
    editMessageFeishu: editMessageFeishuMock,
    getChatInfo: getChatInfoMock,
    getChatMembers: getChatMembersMock,
    buildFeishuDirectChatMembers: buildFeishuDirectChatMembersMock,
    assertFeishuChatMember: assertFeishuChatMemberMock,
    getFeishuMemberInfo: getFeishuMemberInfoMock,
    getMessageFeishu: getMessageFeishuMock,
    listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveMock,
    listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveMock,
    listPinsFeishu: listPinsFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    probeFeishu: probeFeishuMock,
    removePinFeishu: removePinFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    sendCardFeishu: sendCardFeishuMock,
    sendMessageFeishu: sendMessageFeishuMock,
    sendStickerFeishu: sendStickerFeishuMock,
    feishuOutbound: {
      sendText: feishuOutboundSendTextMock,
      sendMedia: feishuOutboundSendMediaMock,
      sendPayload: feishuOutboundSendPayloadMock,
    },
  },
}));

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} mock calls`);
  }
  const call = calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function resultDetails(result: unknown) {
  return requireRecord(requireRecord(result, "action result").details, "action result details");
}

afterAll(() => {
  vi.doUnmock("./probe.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("feishuPlugin actions", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_main",
        appSecret: "secret_main",
        actions: {
          reactions: true,
        },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
      },
    },
  } as OpenClawConfig;

  // Table modes read the channel default from the plugin meta, and the harness
  // does not load the runtime setup, so register the real plugin for every test.
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
    );
    createFeishuClientMock.mockReturnValue({ tag: "client" });
    getChatInfoMock.mockResolvedValue({
      chat_id: "oc_group_1",
      chat_mode: "group",
      chat_type: "private",
    });
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  describe("presentation card markdown table modes", () => {
    const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";

    function tableModeCfg(
      selection: "channel" | "named" | "defaultAccount",
      tables: MarkdownTableMode,
    ): OpenClawConfig {
      return {
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "open",
            allowFrom: ["*"],
            groupPolicy: "open",
            markdown: { tables: selection === "channel" ? tables : "off" },
            ...(selection === "defaultAccount" ? { defaultAccount: "work" } : {}),
            accounts: {
              work: {
                appId: "cli_work",
                appSecret: "secret_work",
                ...(selection === "channel" ? {} : { markdown: { tables } }),
              },
              other: { appId: "cli_other", appSecret: "secret_other" },
            },
          },
        },
      } as OpenClawConfig;
    }

    async function cardMarkdownForPresentationTable(params: {
      cfg: OpenClawConfig;
      accountId?: string;
      action?: "send" | "thread-reply";
    }): Promise<string[]> {
      sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });
      const action = params.action ?? "send";
      await feishuPlugin.actions?.handleAction?.({
        action,
        params: {
          to: "chat:oc_group_1",
          ...(action === "thread-reply" ? { messageId: "om_root" } : {}),
          presentation: {
            blocks: [
              { type: "text", text: tableMarkdown },
              { type: "context", text: tableMarkdown },
            ],
          },
        },
        cfg: params.cfg,
        accountId: params.accountId,
        toolContext: {},
      } as never);

      const sendCardArgs = requireRecord(
        mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
        "send card args",
      );
      const card = requireRecord(sendCardArgs.card, "card");
      const body = requireRecord(card.body, "card body");
      return requireArray(body.elements, "card elements").map((element) =>
        String(requireRecord(element, "card element").content),
      );
    }

    // The action builds its own presentation card, so the mode has to reach that
    // build the same way it reaches the presentation fallback through sendPayload.
    it.each(
      (["bullets", "code"] as const).flatMap((tables) =>
        (["channel", "named", "defaultAccount"] as const).map((selection) => ({
          tables,
          selection,
        })),
      ),
    )(
      "converts a $selection $tables table on a sent presentation card",
      async ({ tables, selection }) => {
        const converted = convertMarkdownTables(tableMarkdown, tables);

        const markdown = await cardMarkdownForPresentationTable({
          cfg: tableModeCfg(selection, tables),
          accountId: selection === "named" ? "work" : undefined,
        });

        // `code` converts the table to a fence, which cannot survive the color tag.
        expect(markdown).toEqual([
          converted,
          tables === "code" ? converted : `<font color='grey'>${converted}</font>`,
        ]);
        expect(markdown.join("\n")).not.toContain("| --- |");
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      },
    );

    it("converts the table a thread-reply presentation card carries", async () => {
      const converted = convertMarkdownTables(tableMarkdown, "bullets");

      const markdown = await cardMarkdownForPresentationTable({
        cfg: tableModeCfg("channel", "bullets"),
        action: "thread-reply",
      });

      expect(markdown).toEqual([converted, `<font color='grey'>${converted}</font>`]);
      expect(markdown.join("\n")).not.toContain("| --- |");
    });

    // off disables table parsing rather than choosing a card-safe shape, so the
    // authored pipes stay on the card the action builds.
    it("keeps the authored table on an off presentation card", async () => {
      const markdown = await cardMarkdownForPresentationTable({
        cfg: tableModeCfg("channel", "off"),
      });

      expect(markdown).toEqual([tableMarkdown, `<font color='grey'>${tableMarkdown}</font>`]);
    });

    // A card draws neither a quoted table nor one a list marker opens, and every mode that
    // converts replaces those rows with a shape it does draw. off converts nothing and asks
    // for the pipes, so the card element has to leave them alone as well.
    it("keeps an authored quoted table on an off presentation card", async () => {
      sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });
      const quoted = "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |";
      await feishuPlugin.actions?.handleAction?.({
        action: "send",
        params: {
          to: "chat:oc_group_1",
          presentation: { blocks: [{ type: "text", text: quoted }] },
        },
        cfg: tableModeCfg("channel", "off"),
        accountId: undefined,
        toolContext: {},
      } as never);

      const sendCardArgs = requireRecord(
        mockCallArg(sendCardFeishuMock, 0, 0, "sendCardFeishu"),
        "send card args",
      );
      const body = requireRecord(requireRecord(sendCardArgs.card, "card").body, "card body");
      const markdown = requireArray(body.elements, "card elements").map((element) =>
        String(requireRecord(element, "card element").content),
      );
      expect(markdown).toEqual(["&gt; | Name | Role |\n&gt; | --- | --- |\n&gt; | Ada | Lead |"]);
    });
  });

  it("falls back to text delivery when presentation text exceeds the card table limit", async () => {
    feishuOutboundSendPayloadMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_fallback",
      chatId: "oc_group_1",
    });
    const sixTables = Array.from(
      { length: 6 },
      (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`,
    ).join("\n\n");

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: sixTables,
        presentation: {
          title: "Status",
          blocks: [{ type: "text", text: "Build completed" }],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(feishuOutboundSendPayloadMock).toHaveBeenCalledTimes(1);
    const payloadArgs = requireRecord(
      mockCallArg(feishuOutboundSendPayloadMock, 0, 0, "feishuOutbound.sendPayload"),
      "sendPayload args",
    );
    expect(payloadArgs.to).toBe("chat:oc_group_1");
    expect(payloadArgs.text).toBe(sixTables);
    const details = resultDetails(result);
    expect(details.ok).toBe(true);
    expect(details.messageId).toBe("om_fallback");
  });
});
