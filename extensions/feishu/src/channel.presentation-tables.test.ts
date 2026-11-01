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

const mocks = vi.hoisted(() => ({
  createFeishuClient: vi.fn(),
  getChatInfo: vi.fn(),
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: vi.fn(),
  sendPayload: vi.fn(),
}));

vi.mock("./probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./probe.js")>()),
  probeFeishu: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: mocks.createFeishuClient,
}));

vi.mock("./channel.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel.runtime.js")>()),
  feishuChannelRuntime: {
    getChatInfo: mocks.getChatInfo,
    sendCardFeishu: mocks.sendCardFeishu,
    sendMessageFeishu: mocks.sendMessageFeishu,
    feishuOutbound: { sendText: vi.fn(), sendMedia: vi.fn(), sendPayload: mocks.sendPayload },
  },
}));

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

function firstCallArg(mock: { mock: { calls: unknown[][] } }, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} call 1`);
  }
  return call[0];
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
        actions: { reactions: true },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", source: "test", plugin: feishuPlugin }]),
    );
    mocks.createFeishuClient.mockReturnValue({ tag: "client" });
    mocks.getChatInfo.mockResolvedValue({
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
    async function cardMarkdownForPresentation(params: {
      cfg: OpenClawConfig;
      accountId?: string;
      action?: "send" | "thread-reply";
      blocks?: unknown[];
    }): Promise<string[]> {
      mocks.sendCardFeishu.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });
      const action = params.action ?? "send";
      await feishuPlugin.actions?.handleAction?.({
        action,
        params: {
          to: "chat:oc_group_1",
          ...(action === "thread-reply" ? { messageId: "om_root" } : {}),
          presentation: {
            blocks: params.blocks ?? [
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
        firstCallArg(mocks.sendCardFeishu, "sendCardFeishu"),
        "send card args",
      );
      const body = requireRecord(requireRecord(sendCardArgs.card, "card").body, "card body");
      const elements = body.elements;
      if (!Array.isArray(elements)) {
        throw new Error("Expected card elements");
      }
      return elements.map((element) => String(requireRecord(element, "card element").content));
    }

    it.each([
      ...(["bullets", "code"] as const).flatMap((tables) =>
        (["channel", "named", "defaultAccount"] as const).map((selection) => ({
          tables,
          selection,
          action: "send" as const,
        })),
      ),
      {
        tables: "bullets" as const,
        selection: "channel" as const,
        action: "thread-reply" as const,
      },
      { tables: "off" as const, selection: "channel" as const, action: "send" as const },
    ])(
      "renders a $selection $tables table on a $action presentation card",
      async ({ tables, selection, action }) => {
        const converted =
          tables === "off"
            ? "| Name | Role |\n| &#45;-- | --- |\n| Ada | Lead |"
            : convertMarkdownTables(tableMarkdown, tables);
        const markdown = await cardMarkdownForPresentation({
          cfg: tableModeCfg(selection, tables),
          accountId: selection === "named" ? "work" : undefined,
          action,
        });
        expect(markdown).toEqual([
          converted,
          tables === "code" ? converted : `<font color='grey'>${converted}</font>`,
        ]);
        if (tables !== "off") {
          expect(markdown.join("\n")).not.toContain("| --- |");
        }
        expect(mocks.sendMessageFeishu).not.toHaveBeenCalled();
      },
    );

    it("keeps a quoted off presentation table literal", async () => {
      const markdown = await cardMarkdownForPresentation({
        cfg: tableModeCfg("channel", "off"),
        blocks: [{ type: "text", text: "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |" }],
      });
      expect(markdown).toEqual([
        "&gt; | Name | Role |\n&gt; | &#45;-- | --- |\n&gt; | Ada | Lead |",
      ]);
    });
  });

  it("falls back when presentation text exceeds the card table limit", async () => {
    mocks.sendPayload.mockResolvedValueOnce({ messageId: "om_sent", chatId: "oc_group_1" });
    const sixTables = Array.from(
      { length: 6 },
      (_, i) => `| a${i} | b${i} |\n| - | - |\n| 1 | 2 |`,
    ).join("\n\n");
    const result = await feishuPlugin.actions?.handleAction?.({
      channel: "feishu",
      cfg,
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: sixTables,
        presentation: { title: "Status", blocks: [{ type: "text", text: "Build completed" }] },
      },
    });
    expect(
      requireRecord(requireRecord(result, "action result").details, "action result details"),
    ).toMatchObject({ ok: true, messageId: "om_sent" });
    expect(mocks.sendCardFeishu).not.toHaveBeenCalled();
    expect(mocks.sendPayload).toHaveBeenCalledOnce();
    expect(firstCallArg(mocks.sendPayload, "feishuOutbound.sendPayload")).toMatchObject({
      to: "chat:oc_group_1",
      text: sixTables,
    });
  });
});
