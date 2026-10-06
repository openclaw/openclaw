import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackEditTestClient, createSlackSendTestClient } from "./blocks.test-helpers.js";
import { slackSetupPlugin } from "./channel.setup.js";
import { countSlackTextUtf8Bytes } from "./truncate.js";

const { editSlackMessage, editSlackRenderedMessage, sendSlackMessage } =
  await import("./actions.js");
type EditOptions = NonNullable<Parameters<typeof editSlackMessage>[3]>;
const tableBlock = {
  type: "data_table",
  caption: "Pipeline report",
  rows: [
    [
      { type: "raw_text", text: "Account" },
      { type: "raw_text", text: "ARR" },
    ],
    [
      { type: "raw_text", text: "Acme" },
      { type: "raw_number", value: 125000, text: "$125k" },
    ],
    [
      { type: "raw_text", text: "Globex" },
      { type: "raw_number", value: 82000, text: "$82k" },
    ],
  ],
  row_header_column_index: 0,
};
const tableSummary =
  "Pipeline report (table)\n- Account: Acme; ARR: $125k\n- Account: Globex; ARR: $82k";
const tablePlain = "Pipeline report (table)\nAccount\tARR\nAcme\t$125k\nGlobex\t$82k";

it("uses the original action text once when a native table is rejected", async () => {
  const client = createSlackSendTestClient();
  client.chat.postMessage.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
  await sendSlackMessage("channel:C123", "Pipeline summary\n\n" + tableSummary, {
    cfg: { channels: { slack: { botToken: "xoxb-test" } } },
    token: "xoxb-test",
    client,
    blocks: [tableBlock],
    nativeDataFallbackBaseText: "Pipeline summary",
  });
  expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
  const fallback = client.chat.postMessage.mock.calls[1]?.[0];
  expect(fallback).toMatchObject({ mrkdwn: false, text: "Pipeline summary\n\n" + tablePlain });
  expect(fallback?.blocks).toBeUndefined();
  expect(fallback?.text?.match(/Acme/gu)).toHaveLength(1);
});

describe("Slack edits", () => {
  let client: ReturnType<typeof createSlackEditTestClient>;
  beforeEach(() => {
    client = createSlackEditTestClient();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
    );
  });
  afterEach(() => resetPluginRuntimeStateForTest());
  function edit(text: string, opts: EditOptions = {}) {
    return editSlackMessage("C123", "171234.567", text, { token: "xoxb-test", client, ...opts });
  }
  function expectUpdate(text: string, blocks?: EditOptions["blocks"]) {
    expect(client.chat.update).toHaveBeenCalledExactlyOnceWith({
      channel: "C123",
      ts: "171234.567",
      text,
      ...(blocks ? { blocks } : {}),
    });
  }

  it.each<{ mode?: MarkdownTableMode; expected: string }>([
    { expected: "```\n| Name | Value |\n| ---- | ----- |\n| Beta | 2     |\n```" },
    { mode: "bullets", expected: "*Beta*\n• Value: 2" },
  ])(
    "renders authored Markdown with the configured default account's $mode table mode",
    async ({ mode, expected }) => {
      await edit(
        "**bold** and [OpenClaw](https://example.com)\n\n| Name | Value |\n| --- | --- |\n| Beta | 2 |",
        {
          cfg: {
            channels: {
              slack: {
                defaultAccount: "work",
                markdown: { tables: mode ? "off" : undefined },
                accounts: { work: { markdown: { tables: mode } } },
              },
            },
          },
        },
      );
      expectUpdate("*bold* and <https://example.com|OpenClaw>\n\n" + expected);
    },
  );

  it("preserves already-rendered mrkdwn when finalizing a preview", async () => {
    await editSlackRenderedMessage("C123", "171234.567", "*bold*", { token: "xoxb-test", client });
    expectUpdate("*bold*");
  });

  it("caps plain-text edits at the UTF-8 byte limit", async () => {
    await edit("x".repeat(3999) + "…" + "a".repeat(8000));
    expectUpdate("x".repeat(3997) + "…");
  });

  it("preserves the empty-edit sentinel", async () => {
    await edit("");
    expectUpdate(" ");
  });

  it("supplies fallback text for non-text blocks", async () => {
    const blocks = [{ type: "divider" }];
    await edit("", { blocks });
    expectUpdate("Shared a Block Kit message", blocks);
  });

  it("retries native data blocks once with complete ordered text and surviving blocks", async () => {
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      {
        type: "data_visualization",
        title: "Revenue mix",
        chart: {
          type: "pie",
          segments: [
            { label: "Product", value: 60 },
            { label: "Services", value: 40 },
          ],
        },
      },
      tableBlock,
    ];
    const chartText = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    await edit("Overview", { blocks });
    expect(client.chat.update).toHaveBeenCalledTimes(2);
    expect(client.chat.update).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      ts: "171234.567",
      text: "Overview\n\n" + chartText + "\n\n" + tableSummary,
      blocks,
    });
    expect(client.chat.update).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      ts: "171234.567",
      text: "Overview\n\n" + chartText + "\n\n" + tablePlain,
      blocks: [
        blocks[0],
        { type: "section", text: { type: "plain_text", text: chartText } },
        { type: "section", text: { type: "plain_text", text: tablePlain } },
      ],
    });
  });

  it("rejects a native chart whose complete fallback exceeds one edit", async () => {
    const categories = Array.from({ length: 20 }, (_, index) =>
      ("Category-" + String(index)).padEnd(20, "x"),
    );
    const block = {
      type: "data_visualization",
      title: "Maximum series chart",
      chart: {
        type: "bar",
        series: Array.from({ length: 12 }, (_, index) => ({
          name: ("Series-" + String(index)).padEnd(20, "x"),
          data: categories.map((label) => ({ label, value: Number.MAX_VALUE })),
        })),
        axis_config: { categories },
      },
    };
    await expect(edit("", { blocks: [block] })).rejects.toThrow(
      "Slack native chart or table fallback exceeds the 4000-byte edit limit",
    );
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("caps block fallback text while preserving edit blocks", async () => {
    const blocks = [
      {
        type: "context",
        elements: Array.from({ length: 3 }, () => ({
          type: "mrkdwn",
          text: "a".repeat(1500),
        })),
      },
    ];
    await edit("", { blocks });
    expect(client.chat.update).toHaveBeenCalledExactlyOnceWith({
      channel: "C123",
      ts: "171234.567",
      text: expect.stringMatching(/…$/u),
      blocks,
    });
    expect(countSlackTextUtf8Bytes(client.chat.update.mock.calls[0]?.[0].text ?? "")).toBe(4000);
  });

  it("rejects more than 50 blocks before the API call", async () => {
    await expect(
      edit("updated", { blocks: Array.from({ length: 51 }, () => ({ type: "divider" })) }),
    ).rejects.toThrow(/cannot exceed 50 items/i);
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("checks escaped retry text against the edit byte limit", async () => {
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Overview" } },
      { type: "section", text: { type: "mrkdwn", text: "<".repeat(1000) } },
      { type: "data_visualization", title: "Chart", chart: { type: "bar", series: [] } },
    ];
    await expect(edit("Overview", { blocks })).rejects.toThrow(
      /fallback exceeds the 4000-byte edit limit/u,
    );
    expect(client.chat.update).toHaveBeenCalledTimes(1);
  });
});
