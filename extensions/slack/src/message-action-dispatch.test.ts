import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { slackSetupPlugin } from "./channel.setup.js";
import {
  createInvokeSpy,
  dispatch as dispatchAction,
} from "./message-action-dispatch.test-support.js";
import { extractSlackToolSend } from "./message-actions.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";

type ActionContext = Parameters<typeof dispatchAction>[1];
function dispatch(
  invoke: ReturnType<typeof createInvokeSpy>,
  action: ActionContext["action"],
  params: ActionContext["params"],
  context: Partial<Omit<ActionContext, "action" | "params">> = {},
) {
  return dispatchAction(invoke, {
    channel: "slack",
    cfg: {},
    ...context,
    action,
    params: action === "edit" ? { channelId: "C1", messageId: "171234.567", ...params } : params,
  });
}

function present<const T extends unknown[]>(...blocks: T) {
  return { blocks };
}

function slackConfig() {
  return { channels: { slack: { botToken: "tok" } } };
}

function firstInvokeCall(invoke: ReturnType<typeof createInvokeSpy>) {
  const [call] = invoke.mock.calls;
  assert(call, "expected first Slack action invoke");
  return call;
}

function expectForwardedCfg(invoke: ReturnType<typeof createInvokeSpy>, cfg: unknown) {
  expect(firstInvokeCall(invoke)[1]).toBe(cfg);
}

function expectNoForwardedToolContext(invoke: ReturnType<typeof createInvokeSpy>) {
  expect(firstInvokeCall(invoke)[2]).toBeUndefined();
}

function firstAction(invoke: ReturnType<typeof createInvokeSpy>) {
  const action = firstInvokeCall(invoke)[0];
  assert(action && typeof action === "object", "expected first invoke action");
  return action;
}

function preparedMessages(invoke: ReturnType<typeof createInvokeSpy>) {
  const context = firstInvokeCall(invoke)[2] as
    | { preparedMessages?: Array<Record<string, unknown>> }
    | undefined;
  const messages = context?.preparedMessages;
  assert(messages?.length, "expected prepared Slack messages");
  return messages;
}

function blockAt(action: Record<string, unknown>, index: number) {
  const blocks = action.blocks as Array<Record<string, unknown>> | undefined;
  const block = blocks?.[index];
  assert(block, `expected Slack block ${index}`);
  return block;
}

function elementAt(block: Record<string, unknown>, index: number) {
  const elements = block.elements as Array<Record<string, unknown>> | undefined;
  const element = elements?.[index];
  assert(element, `expected Slack block element ${index}`);
  return element;
}

function largeTablePresentation() {
  return {
    blocks: [
      {
        type: "table",
        caption: "Large pipeline",
        headers: ["Account"],
        rows: Array.from({ length: 100 }, (_entry, index) => [
          index === 0 ? "<@U123>" : `account-${String(index)} ${"x".repeat(110)}`,
        ]),
      },
    ],
  };
}

const paddedMarkdownTable = [
  `| ${"H".repeat(200)} | Value |`,
  "| --- | --- |",
  ...Array.from({ length: 20 }, () => "| x | 2 |"),
].join("\n");

describe("Slack action adapter", () => {
  let invoke: ReturnType<typeof createInvokeSpy>;
  beforeEach(() => {
    invoke = createInvokeSpy();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
    );
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  it("defaults reactions to the current inbound Slack message", async () => {
    const toolContext = { currentMessageId: "171234.567" };

    await dispatch(
      invoke,
      "react",
      {
        channelId: "C1",
        emoji: "✅",
      },
      { toolContext },
    );

    expect(firstAction(invoke)).toMatchObject({
      action: "react",
      channelId: "C1",
      emoji: "✅",
      messageId: "171234.567",
    });
    expect(firstInvokeCall(invoke)[2]).toMatchObject(toolContext);
  });

  it("sends an exact mirrored portable control row once", async () => {
    const buttons = [{ label: "Approve", action: { type: "callback" as const, value: "approve" } }];

    await dispatch(invoke, "send", {
      to: "channel:C1",
      message: "Deploy?",
      presentation: present({ type: "buttons", buttons }),
      interactive: present({ type: "buttons", buttons }),
    });

    const action = firstAction(invoke);
    expect(action).not.toHaveProperty("blocks");
    const message = preparedMessages(invoke)[0]!;
    const blocks = message.blocks as Array<Record<string, unknown>> | undefined;
    const actions = blocks?.filter((block) => block.type === "actions") ?? [];
    expect(actions).toHaveLength(1);
    expect(elementAt(actions[0]!, 0).value).toBe("approve");
  });

  it("sends native charts with a complete accessible text representation", async () => {
    await dispatch(invoke, "send", {
      to: "channel:C1",
      message: "Revenue summary",
      presentation: present({
        type: "chart",
        chartType: "pie",
        title: "Revenue mix",
        segments: [
          { label: "Product", value: 60 },
          { label: "Services", value: 40 },
        ],
      }),
    });

    const action = firstAction(invoke);
    expect(action.content).toBe("Revenue summary");
    expect(action).not.toHaveProperty("blocks");
    expect(action).not.toHaveProperty("nativeDataFallbackBaseText");
    const message = preparedMessages(invoke)[0]!;
    expect(message.text).toBe(
      "Revenue summary\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(blockAt(message, 1)).toEqual({
      type: "data_visualization",
      title: "Revenue mix",
      chart: {
        type: "pie",
        segments: [
          { label: "Product", value: 60 },
          { label: "Services", value: 40 },
        ],
      },
    });
  });

  it("sends native tables with a complete accessible text representation", async () => {
    await dispatch(invoke, "send", {
      to: "channel:C1",
      message: "Pipeline summary",
      presentation: present({
        type: "table",
        caption: "Pipeline",
        headers: ["Account", "ARR"],
        rows: [
          ["Acme", 125000],
          ["Globex", 82000],
        ],
      }),
    });

    const action = firstAction(invoke);
    expect(action.content).toBe("Pipeline summary");
    const message = preparedMessages(invoke)[0]!;
    expect(message.text).toBe(
      "Pipeline summary\n\nPipeline (table)\nAccount\tARR\nAcme\t125000\nGlobex\t82000",
    );
  });

  it.each([
    { name: "ASCII", message: `${"x".repeat(4_000)}TAIL` },
    { name: "multibyte", message: `${"😀".repeat(1_000)}TAIL` },
    { name: "expanded Slack markdown", message: `${"&".repeat(801)}TAIL` },
    {
      name: "padded Markdown table",
      message: paddedMarkdownTable,
    },
  ])("rejects oversized $name text-only edits before sending", async ({ message }) => {
    await expect(dispatch(invoke, "edit", { message })).rejects.toThrow(
      "Slack edit exceeds the 4000-byte edit limit. Send a new message instead.",
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["off", "bullets"] as const)(
    "measures the account's %s table rendering before rejecting an edit",
    async (tables) => {
      await dispatch(
        invoke,
        "edit",
        { message: paddedMarkdownTable },
        {
          cfg: {
            channels: {
              slack: {
                defaultAccount: "work",
                markdown: { tables: "code" },
                accounts: { work: { markdown: { tables } } },
              },
            },
          },
        },
      );
      expect(firstAction(invoke)).toMatchObject({
        action: "editMessage",
        content: paddedMarkdownTable,
      });
    },
  );

  it("accepts a text-only edit at Slack's exact byte limit", async () => {
    const message = "x".repeat(4_000);

    await dispatch(invoke, "edit", { message });

    expect(firstAction(invoke)).toMatchObject({ action: "editMessage", content: message });
  });

  it("keeps oversized notification fallback for visibly rendered block edits", async () => {
    const message = "x".repeat(4_001);

    await dispatch(invoke, "edit", {
      message,
      presentation: present({ type: "text", text: "Visible block content" }),
    });

    expect(firstAction(invoke)).toMatchObject({ action: "editMessage", content: message });
    expect(blockAt(firstAction(invoke), 0)).toMatchObject({ type: "section" });
  });

  it("edits native tables with a complete accessible text representation", async () => {
    await dispatch(invoke, "edit", {
      message: "Updated pipeline",
      presentation: present({
        type: "table",
        caption: "Pipeline",
        headers: ["Account", "Stage"],
        rows: [["Acme", "Won"]],
      }),
    });

    expect(firstAction(invoke)).toMatchObject({
      action: "editMessage",
      channelId: "C1",
      messageId: "171234.567",
      content: "Updated pipeline\n\nPipeline (table)\n- Account: Acme; Stage: Won",
    });
  });

  it("routes non-native tables through Slack-safe text with native controls", async () => {
    await dispatch(invoke, "send", {
      to: "channel:C1",
      message: "Summary",
      presentation: present(
        {
          type: "chart",
          chartType: "pie",
          title: "Revenue mix",
          segments: [{ label: "Product", value: 60 }],
        },
        ...largeTablePresentation().blocks,
        {
          type: "buttons",
          buttons: [{ label: "Stage", value: "stage" }],
        },
        {
          type: "select",
          placeholder: "Lane",
          options: [{ label: "Production", value: "production" }],
        },
      ),
      interactive: present(
        {
          type: "buttons",
          buttons: [{ label: "Refresh", value: "refresh" }],
        },
        {
          type: "select",
          placeholder: "Window",
          options: [{ label: "Recent", value: "recent" }],
        },
      ),
    });

    const action = firstAction(invoke);
    expect(action).not.toHaveProperty("separateTextAndBlocks");
    expect(action).not.toHaveProperty("blocks");
    const messages = preparedMessages(invoke);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.text).toBe("Summary\n\nRevenue mix (pie chart)\n- Product: 60");
    expect(blockAt(messages[0]!, 1).type).toBe("data_visualization");
    expect(messages[1]?.text).toContain("- Account: <@U123>");
    expect(messages[1]?.text).toContain("- Account: account-99");
    expect(messages[1]?.textIsSlackPlainText).toBe(true);
    const controls = messages[2]!;
    const presentationButtons = blockAt(controls, 0);
    expect(presentationButtons.block_id).toBe("openclaw_reply_buttons_1");
    expect(elementAt(presentationButtons, 0)).toMatchObject({
      action_id: "openclaw:reply_button:1:1",
      value: "stage",
    });
    const presentationSelect = blockAt(controls, 1);
    expect(presentationSelect.block_id).toBe("openclaw_reply_select_1");
    expect(elementAt(presentationSelect, 0).action_id).toBe("openclaw:reply_select:1");
    const legacyButtons = blockAt(controls, 2);
    expect(legacyButtons.block_id).toBe("openclaw_reply_buttons_2");
    expect(elementAt(legacyButtons, 0)).toMatchObject({
      action_id: "openclaw:reply_button:2:1",
      value: "refresh",
    });
    const legacySelect = blockAt(controls, 3);
    expect(legacySelect.block_id).toBe("openclaw_reply_select_2");
    expect(elementAt(legacySelect, 0).action_id).toBe("openclaw:reply_select:2");
    expect(String(messages[1]?.text).length).toBeGreaterThan(8000);
  });

  it("keeps an oversized portable control label complete in literal fallback", async () => {
    const label = `Deploy ${"x".repeat(80)}`;

    await dispatch(invoke, "send", {
      to: "channel:C1",
      presentation: present({ type: "buttons", buttons: [{ label, value: "deploy" }] }),
    });

    const action = firstAction(invoke);
    expect(action).not.toHaveProperty("blocks");
    expect(action).not.toHaveProperty("preparedMessages");
    expect(preparedMessages(invoke)).toEqual([{ text: `- ${label}`, textIsSlackPlainText: true }]);
  });

  it("uses text-only edits for non-native tables that fit one message", async () => {
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);

    await dispatch(invoke, "edit", {
      presentation: present({
        type: "table",
        caption: "Wide pipeline",
        headers,
        rows: [headers.map((_header, index) => `Value ${String(index)}`)],
      }),
    });

    const action = firstAction(invoke);
    expect(action.blocks).toBeUndefined();
    expect(action.content).toContain("Column 20: Value 20");
  });

  it("rejects non-native table edits whose complete fallback cannot fit", async () => {
    const headers = Array.from({ length: 21 }, (_entry, index) => `Column ${String(index)}`);
    const presentation = {
      blocks: [
        {
          type: "table" as const,
          caption: "Wide pipeline",
          headers,
          rows: Array.from({ length: 10 }, (_row, rowIndex) =>
            headers.map(
              (_header, columnIndex) => `Value ${String(rowIndex)}-${String(columnIndex)}`,
            ),
          ),
        },
      ],
    };
    const fallback = renderSlackMessagePresentationFallbackText({ presentation });
    expect(fallback.length).toBeGreaterThan(4000);
    expect(fallback.length).toBeLessThan(8000);

    await expect(
      dispatch(invoke, "edit", {
        presentation,
      }),
    ).rejects.toThrow("Slack presentation fallback exceeds the 4000-byte edit limit");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects non-native chart edits whose complete fallback cannot fit", async () => {
    const categories = Array.from(
      { length: 21 },
      (_entry, index) => `Category ${String(index)} ${"x".repeat(200)}`,
    );
    const presentation = {
      blocks: [
        {
          type: "chart" as const,
          chartType: "line" as const,
          title: "Long trend",
          categories,
          series: [{ name: "Series", values: categories.map((_category, index) => index) }],
        },
      ],
    };
    expect(renderSlackMessagePresentationFallbackText({ presentation }).length).toBeGreaterThan(
      4000,
    );

    await expect(dispatch(invoke, "edit", { presentation })).rejects.toThrow(
      "Slack presentation fallback exceeds the 4000-byte edit limit",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps an unrenderable control label complete in text-only edits", async () => {
    const label = `Deploy ${"x".repeat(80)}`;

    await dispatch(invoke, "edit", {
      presentation: present({ type: "buttons", buttons: [{ label, value: "deploy" }] }),
    });

    expect(firstAction(invoke)).toMatchObject({ content: `- ${label}`, blocks: undefined });
  });

  it.each(["text", "context"] as const)(
    "keeps a complete oversized %s presentation in one text-only edit",
    async (type) => {
      const text = "x".repeat(3_001);

      await dispatch(invoke, "edit", {
        presentation: present({ type, text }),
      });

      expect(firstAction(invoke)).toMatchObject({ content: text, blocks: undefined });
    },
  );

  it.each([
    { name: "Slack markdown rendering", text: `${"&".repeat(801)}${"x".repeat(2_200)}` },
    { name: "UTF-8 expansion", text: "😀".repeat(1_501) },
  ])("rejects presentation fallback edits that overflow after $name", async ({ text }) => {
    await expect(
      dispatch(invoke, "edit", {
        presentation: present({ type: "text", text }),
      }),
    ).rejects.toThrow(
      "Slack presentation fallback exceeds the 4000-byte edit limit. Send a new message instead.",
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses complete text-only fallback when an edit exceeds fifty blocks", async () => {
    const presentation = {
      blocks: Array.from({ length: 51 }, (_entry, index) => ({
        type: "text" as const,
        text: `Detail ${String(index)}`,
      })),
    };

    await dispatch(invoke, "edit", { presentation });

    const action = firstAction(invoke);
    expect(action.blocks).toBeUndefined();
    expect(action.content).toContain("Detail 0");
    expect(action.content).toContain("Detail 50");
  });

  it("passes media and rendered interactive blocks through for split Slack delivery", async () => {
    const cfg = slackConfig();

    await dispatch(
      invoke,
      "send",
      {
        to: "channel:C1",
        message: "Approval required",
        media: "https://example.com/report.md",
        interactive: present({
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        }),
      },
      { cfg },
    );

    expect(invoke).toHaveBeenCalledOnce();
    const action = firstAction(invoke);
    expect(action.action).toBe("sendMessage");
    expect(action.to).toBe("channel:C1");
    expect(action.content).toBe("Approval required");
    expect(action.mediaUrl).toBe("https://example.com/report.md");
    expect(action).not.toHaveProperty("blocks");
    const message = preparedMessages(invoke)[0]!;
    expect(blockAt(message, 0).type).toBe("section");
    const actionsBlock = blockAt(message, 1);
    expect(actionsBlock.type).toBe("actions");
    expect(elementAt(actionsBlock, 0).value).toBe("approve");
    expectForwardedCfg(invoke, cfg);
  });

  it.each([
    ["explicit reply wins", { threadId: "111.222", replyTo: "999.000" }, { threadTs: "999.000" }],
    [
      "invalid reply uses thread",
      { threadId: "111.222", replyTo: "msg-internal-1" },
      { threadTs: "111.222" },
    ],
    [
      "broadcast",
      { threadId: "111.222", replyBroadcast: true },
      { threadTs: "111.222", replyBroadcast: true },
    ],
    ["topLevel", { topLevel: true }, { threadTs: undefined, topLevel: true }],
    ["null thread", { threadId: null }, { threadTs: undefined, topLevel: true }],
  ] as const)("routes send: %s", async (_name, params, expected) => {
    const cfg = slackConfig();
    await dispatch(invoke, "send", { to: "channel:C1", message: "Reply", ...params }, { cfg });
    expect(firstAction(invoke)).toMatchObject({
      action: "sendMessage",
      to: "channel:C1",
      content: "Reply",
      ...expected,
    });
    expect(firstAction(invoke).threadTs).toBe(expected.threadTs);
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it.each([
    [
      "native fields",
      {
        to: "user:U1",
        filePath: "/tmp/report.png",
        initialComment: "fresh build",
        filename: "build.png",
        title: "Build Screenshot",
        threadId: "111.222",
      },
      {
        to: "user:U1",
        filePath: "/tmp/report.png",
        initialComment: "fresh build",
        filename: "build.png",
        title: "Build Screenshot",
        threadTs: "111.222",
      },
    ],
    [
      "media/message/replyTo aliases",
      { channelId: "C1", media: "/tmp/chart.png", message: "chart attached", replyTo: "333.444" },
      {
        to: "C1",
        filePath: "/tmp/chart.png",
        initialComment: "chart attached",
        threadTs: "333.444",
      },
    ],
    [
      "path alias",
      { to: "channel:C1", path: "/tmp/report.txt", initialComment: "path alias" },
      { to: "channel:C1", filePath: "/tmp/report.txt", initialComment: "path alias" },
    ],
    [
      "caption alias",
      { channelId: "C1", media: "/tmp/chart.png", caption: "chart attached" },
      { filePath: "/tmp/chart.png", initialComment: "chart attached" },
    ],
    [
      "empty comment overrides message and caption",
      {
        channelId: "C1",
        media: "/tmp/chart.png",
        initialComment: "",
        message: "message text",
        caption: "caption text",
      },
      { filePath: "/tmp/chart.png", initialComment: "" },
    ],
  ] as const)("maps upload-file: %s", async (_name, params, expected) => {
    const cfg = slackConfig();
    await dispatch(invoke, "upload-file", params, { cfg });
    expect(firstAction(invoke)).toMatchObject({ action: "uploadFile", ...expected });
    expectForwardedCfg(invoke, cfg);
    expectNoForwardedToolContext(invoke);
  });

  it.each(["forceDocument", "asDocument"] as const)(
    "normalizes %s for Slack send and upload-file",
    async (propertyName) => {
      const sendInvoke = createInvokeSpy();
      await dispatch(
        sendInvoke,
        "send",
        {
          to: "channel:C1",
          media: "/tmp/original.png",
          [propertyName]: true,
        },
        { cfg: slackConfig() },
      );
      expect(firstAction(sendInvoke)).toMatchObject({
        action: "sendMessage",
        forceDocument: true,
      });

      const uploadInvoke = createInvokeSpy();
      await dispatch(
        uploadInvoke,
        "upload-file",
        {
          to: "channel:C1",
          filePath: "/tmp/original.png",
          [propertyName]: true,
        },
        { cfg: slackConfig() },
      );
      expect(firstAction(uploadInvoke)).toMatchObject({
        action: "uploadFile",
        forceDocument: true,
      });
    },
  );

  it("rejects replyBroadcast for upload-file", async () => {
    await expect(
      dispatch(createInvokeSpy(), "upload-file", {
        to: "channel:C1",
        filePath: "/tmp/report.png",
        threadId: "111.222",
        replyBroadcast: true,
      }),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
  });

  it("forwards messageId for read actions", async () => {
    await dispatch(invoke, "read", {
      channelId: "C1",
      messageId: "1712345678.654321",
    });

    const action = firstAction(invoke);
    expect(action.action).toBe("readMessages");
    expect(action.channelId).toBe("C1");
    expect(action.messageId).toBe("1712345678.654321");
    expect(firstInvokeCall(invoke)[1]).toEqual({});
  });

  it.each([2.5])("forwards raw read limit %s to the authorized action owner", async (limit) => {
    await dispatch(invoke, "read", { channelId: "C1", limit });

    expect(firstAction(invoke)).toMatchObject({ action: "readMessages", limit });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("requires filePath, path, or media for upload-file", async () => {
    await expect(
      dispatch(createInvokeSpy(), "upload-file", {
        to: "channel:C1",
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);
  });

  it.each([
    {
      name: "maps download-file to the internal downloadFile action",
      params: { channelId: "C1", fileId: "F123", threadId: "111.222" },
      expected: { fileId: "F123", channelId: "C1", threadId: "111.222" },
    },
    {
      name: "maps download-file target aliases to scope fields",
      params: { to: "channel:C2", fileId: "F999", replyTo: "333.444" },
      expected: { fileId: "F999", channelId: "channel:C2", threadId: "333.444" },
    },
  ])("$name", async ({ params, expected }) => {
    const cfg = slackConfig();
    await dispatch(invoke, "download-file", params, { cfg });
    expect(firstAction(invoke)).toMatchObject({ action: "downloadFile", ...expected });
    expectForwardedCfg(invoke, cfg);
  });

  it("forwards tool context for current-channel download-file actions", async () => {
    const cfg = slackConfig();
    const toolContext = { currentChannelId: "C1" };

    await dispatch(
      invoke,
      "download-file",
      {
        fileId: "F123",
      },
      { cfg, toolContext },
    );

    const action = firstAction(invoke);
    expect(action.action).toBe("downloadFile");
    expect(action.fileId).toBe("F123");
    expect(action.channelId).toBeUndefined();
    expectForwardedCfg(invoke, cfg);
    expect(firstInvokeCall(invoke)[2]).toMatchObject(toolContext);
  });

  it.each([
    {
      name: "explains that download-file requires fileId, not messageId",
      params: { channelId: "C1", messageId: "1777423717.666499" },
      expectedError: /Did you mean to pass fileId/i,
    },
    {
      name: "explains that download-file requires fileId for message_id aliases",
      params: { channelId: "C1", message_id: "1777423717.666499" },
      expectedError: /Did you mean to pass fileId/i,
    },
    {
      name: "keeps the generic fileId requirement when no message id was supplied",
      params: { channelId: "C1" },
      expectedError: /fileId/i,
    },
  ])("$name", async ({ params, expectedError }) => {
    await expect(dispatch(createInvokeSpy(), "download-file", params, { cfg: {} })).rejects.toThrow(
      expectedError,
    );
  });

  it("defaults member-info userId to the inbound sender when omitted", async () => {
    const toolContext = { currentChannelProvider: " Slack " };

    await dispatch(
      invoke,
      "member-info",
      {},
      { accountId: "OPS", requesterAccountId: "ops", requesterSenderId: "U123", toolContext },
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "memberInfo", userId: "U123" }),
      expect.any(Object),
      expect.objectContaining({
        ...toolContext,
        requesterAccountId: "ops",
        requesterSenderId: "U123",
      }),
    );
  });

  it("defaults member-info userId through the configured default Slack account", async () => {
    const toolContext = { currentChannelProvider: "slack" };

    await dispatch(
      invoke,
      "member-info",
      {},
      {
        cfg: { channels: { slack: { defaultAccount: "ops", accounts: { ops: {} } } } },
        requesterAccountId: "OPS",
        requesterSenderId: "U123",
        toolContext,
      },
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "memberInfo", userId: "U123" }),
      expect.any(Object),
      expect.objectContaining({
        ...toolContext,
        requesterAccountId: "OPS",
        requesterSenderId: "U123",
      }),
    );
  });

  it.each([
    ["has no source provider", { requesterSenderId: "U123" }],
    [
      "has no source account",
      {
        accountId: "default",
        requesterSenderId: "U123",
        toolContext: { currentChannelProvider: "slack" },
      },
    ],
    [
      "targets another Slack account",
      {
        accountId: "other",
        requesterAccountId: "default",
        requesterSenderId: "U123",
        toolContext: { currentChannelProvider: "slack" },
      },
    ],
    [
      "comes from another provider",
      { requesterSenderId: "U123", toolContext: { currentChannelProvider: "telegram" } },
    ],
  ])("rejects member-info without userId when the request %s", async (_label, context) => {
    await expect(dispatch(createInvokeSpy(), "member-info", {}, { ...context })).rejects.toThrow(
      /member-info requires a userId/i,
    );
  });

  it("prefers an explicit member-info userId over the inbound sender", async () => {
    const toolContext = { currentChannelProvider: "telegram" };

    await dispatch(
      invoke,
      "member-info",
      { userId: "U999" },
      { accountId: "other", requesterAccountId: "default", requesterSenderId: "U123", toolContext },
    );

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "memberInfo", userId: "U999" }),
      expect.any(Object),
      expect.objectContaining({
        ...toolContext,
        requesterAccountId: "default",
        requesterSenderId: "U123",
      }),
    );
  });
});

describe("extractSlackToolSend", () => {
  it.each([
    [{ action: "sendMessage", threadTs: "171.222" }, { threadId: "171.222" }],
    [{ action: "sendMessage" }, { threadImplicit: true }],
    [{ action: "uploadFile" }, { threadImplicit: true }],
    [{ action: "sendMessage", threadTs: null }, { threadSuppressed: true }],
    [{ action: "send", threadId: "111.000", replyTo: "999.000" }, { threadId: "999.000" }],
    [{ action: "upload-file", threadId: "111.000", replyTo: "999.000" }, { threadId: "111.000" }],
    [{ action: "upload-file", replyTo: "999.000" }, { threadId: "999.000" }],
  ])("maps thread telemetry %j", (args, expected) => {
    expect(extractSlackToolSend({ to: "channel:C1", ...args })).toMatchObject({
      to: "channel:C1",
      ...expected,
    });
  });
});
