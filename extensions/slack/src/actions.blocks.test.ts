import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackEditTestClient, createSlackSendTestClient } from "./blocks.test-helpers.js";
import { slackSetupPlugin } from "./channel.setup.js";

const { editSlackMessage, sendSlackMessage } = await import("./actions.js");
type EditOptions = NonNullable<Parameters<typeof editSlackMessage>[3]>;
const textCell = (text: string) => ({ type: "raw_text", text });
const revenueRow = (name: string, value: number, text: string) => [
  textCell(name),
  { type: "raw_number", value, text },
];
const tableBlock = {
  type: "data_table",
  caption: "Pipeline report",
  row_header_column_index: 0,
  rows: [
    ["Account", "ARR"].map(textCell),
    revenueRow("Acme", 125000, "$125k"),
    revenueRow("Globex", 82000, "$82k"),
  ],
};
const tableSummary =
  "Pipeline report (table)\n- Account: Acme; ARR: $125k\n- Account: Globex; ARR: $82k";
const tablePlain = "Pipeline report (table)\nAccount\tARR\nAcme\t$125k\nGlobex\t$82k";
const section = (text: string, type = "mrkdwn") => ({ type: "section", text: { type, text } });
const chart = (title: string, data: Record<string, unknown>) => ({
  type: "data_visualization",
  title,
  chart: data,
});

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
  const update = (text: string, blocks?: EditOptions["blocks"]) => ({
    channel: "C123",
    ts: "171234.567",
    text,
    ...(blocks ? { blocks } : {}),
  });
  function expectUpdate(text: string) {
    expect(client.chat.update).toHaveBeenCalledExactlyOnceWith(update(text));
  }

  it.each<{ mode?: MarkdownTableMode; expected: string }>([
    { expected: "```\n| Name | Value |\n| ---- | ----- |\n| Beta | 2     |\n```" },
    { mode: "bullets", expected: "*Beta*\n• Value: 2" },
  ])("uses the default account's $mode Markdown table mode", async ({ mode, expected }) => {
    const slack = {
      defaultAccount: "work",
      markdown: { tables: mode ? ("off" as const) : undefined },
      accounts: { work: { markdown: { tables: mode } } },
    };
    await edit(
      "**bold** and [OpenClaw](https://example.com)\n\n| Name | Value |\n| --- | --- |\n| Beta | 2 |",
      { cfg: { channels: { slack } } },
    );
    expectUpdate("*bold* and <https://example.com|OpenClaw>\n\n" + expected);
  });

  it.each([
    [
      "caps plain-text edits at the UTF-8 byte limit",
      "x".repeat(3999) + "…" + "a".repeat(8000),
      "x".repeat(3997) + "…",
    ],
    ["preserves the empty-edit sentinel", "", " "],
  ])("%s", async (_name, input, expected) => {
    await edit(input);
    expectUpdate(expected);
  });

  it("retries native data blocks once with complete ordered text and surviving blocks", async () => {
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    const overview = section("Overview");
    const blocks = [
      overview,
      chart("Revenue mix", {
        type: "pie",
        segments: [
          { label: "Product", value: 60 },
          { label: "Services", value: 40 },
        ],
      }),
      tableBlock,
    ];
    const chartText = "Revenue mix (pie chart)\n- Product: 60\n- Services: 40";
    await edit("Overview", { blocks });
    expect(client.chat.update.mock.calls).toEqual([
      [update("Overview\n\n" + chartText + "\n\n" + tableSummary, blocks)],
      [
        update("Overview\n\n" + chartText + "\n\n" + tablePlain, [
          overview,
          section(chartText, "plain_text"),
          section(tablePlain, "plain_text"),
        ]),
      ],
    ]);
  });

  it("rejects a native chart whose complete fallback exceeds one edit", async () => {
    const categories = Array.from({ length: 20 }, (_, i) => ("Category-" + i).padEnd(20, "x"));
    const block = chart("Maximum series chart", {
      type: "bar",
      axis_config: { categories },
      series: Array.from({ length: 12 }, (_, i) => ({
        name: ("Series-" + i).padEnd(20, "x"),
        data: categories.map((label) => ({ label, value: Number.MAX_VALUE })),
      })),
    });
    await expect(edit("", { blocks: [block] })).rejects.toThrow(
      "Slack native chart or table fallback exceeds the 4000-byte edit limit",
    );
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects more than 50 blocks before the API call", async () => {
    await expect(
      edit("updated", { blocks: Array.from({ length: 51 }, () => ({ type: "divider" })) }),
    ).rejects.toThrow(/cannot exceed 50 items/i);
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("checks escaped retry text against the edit byte limit", async () => {
    client.chat.update.mockRejectedValueOnce({ data: { error: "invalid_blocks" } });
    await expect(
      edit("Overview", {
        blocks: [
          section("Overview"),
          section("<".repeat(1000)),
          chart("Chart", { type: "bar", series: [] }),
        ],
      }),
    ).rejects.toThrow(/fallback exceeds the 4000-byte edit limit/u);
    expect(client.chat.update).toHaveBeenCalledTimes(1);
  });
});
