import { describe, expect, it } from "vitest";
import { resolveSlackBlocksText, resolveSlackMessageText } from "./block-text.js";

describe("resolveSlackBlocksText data visualizations", () => {
  it("uses the shared visible-text parser for rich text, fields, and controls", () => {
    const resolved = resolveSlackBlocksText([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Ask " },
              { type: "user", user_id: "U123" },
            ],
          },
        ],
      },
      {
        type: "section",
        text: { type: "plain_text", text: "Deploy" },
        fields: [{ type: "plain_text", text: "Healthy" }],
      },
      {
        type: "actions",
        block_id: "private-block",
        elements: [
          {
            type: "workflow_button",
            text: { type: "plain_text", text: "Run workflow" },
            action_id: "private-action",
            workflow: { trigger: { url: "https://example.com/private" } },
          },
          {
            type: "static_select",
            placeholder: { type: "plain_text", text: "Choose owner" },
            action_id: "private-select",
            options: [
              { text: { type: "plain_text", text: "Hidden option" }, value: "private-value" },
            ],
          },
        ],
      },
    ]);

    expect(resolved).toEqual({
      text: "Ask &lt;@U123&gt;\nDeploy\nHealthy\nRun workflow\nChoose owner",
      hasRichText: true,
      hasNativeData: false,
    });
    expect(resolved?.text).not.toMatch(/private|Hidden option/u);
  });

  it("preserves native chart values in inbound conversation context", () => {
    expect(
      resolveSlackBlocksText([
        {
          type: "data_visualization",
          title: "Weekly latency",
          chart: {
            type: "line",
            series: [
              {
                name: "p95",
                data: [
                  { label: "Mon", value: 250 },
                  { label: "Tue", value: 230 },
                ],
              },
            ],
            axis_config: {
              categories: ["Mon", "Tue"],
              x_label: "Day",
              y_label: "Milliseconds",
            },
          },
        },
      ]),
    ).toEqual({
      text: [
        "Weekly latency (line chart)",
        "X axis: Day",
        "Y axis: Milliseconds",
        "- p95: Mon: 250; Tue: 230",
      ].join("\n"),
      hasRichText: false,
      hasNativeData: true,
    });
  });

  it("preserves native table values in inbound conversation context", () => {
    expect(
      resolveSlackBlocksText([
        {
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
          ],
        },
      ]),
    ).toEqual({
      text: "Pipeline report (table)\n- Account: Acme; ARR: $125k",
      hasRichText: false,
      hasNativeData: true,
    });
  });

  it("renders basic table cells as ordered, delimiter-safe TSV", () => {
    const table = {
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Name" },
          { type: "raw_text", text: "Count" },
          { type: "raw_text", text: "Owner" },
          { type: "raw_text", text: "Note" },
        ],
        [
          { type: "raw_text", text: "A\tB\nC\\D" },
          { type: "raw_number", value: 12, text: "12 items" },
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "Ada" },
                  { type: "text", text: " " },
                  { type: "user", user_id: "U123" },
                ],
              },
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "Team A" }],
              },
            ],
          },
          { type: "raw_text", text: "" },
        ],
        [
          { type: "unknown", text: "ignored" },
          { type: "raw_number", value: "not-a-number", text: "ignored" },
          null,
          { type: "raw_text", text: "tail" },
        ],
        "not-a-row",
      ],
    };

    expect(resolveSlackBlocksText([table])).toEqual({
      text: [
        "Name\tCount\tOwner\tNote",
        "A\\tB\\nC\\\\D\t12 items\tAda <@U123>\\nTeam A\t",
        "\t\t\ttail",
      ].join("\n"),
      hasRichText: false,
      hasNativeData: true,
      hasBasicTable: true,
    });
  });

  it("appends only attachment tables and deduplicates already-rendered rows", () => {
    const table = {
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "ID" },
          { type: "raw_text", text: "Status" },
        ],
        [
          { type: "raw_number", value: 12345, text: "12345" },
          { type: "raw_text", text: "enabled" },
        ],
      ],
    };
    const rendered = "Please check these.\nID\tStatus\n12345\tenabled";

    expect(
      resolveSlackMessageText({
        text: "Please check these.",
        attachments: [
          {
            blocks: [{ type: "section", text: { type: "mrkdwn", text: "unfurl text" } }, table],
          },
        ],
      }),
    ).toBe(rendered);
    expect(resolveSlackMessageText({ text: rendered, attachments: [{ blocks: [table] }] })).toBe(
      rendered,
    );

    const secondTable = {
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Team" },
          { type: "raw_text", text: "Owner" },
        ],
        [
          { type: "raw_text", text: "Platform" },
          { type: "raw_text", text: "Ada" },
        ],
      ],
    };
    expect(
      resolveSlackMessageText({
        text: rendered,
        attachments: [{ blocks: [table, secondTable] }],
      }),
    ).toBe(`${rendered}\nTeam\tOwner\nPlatform\tAda`);
    expect(
      resolveSlackMessageText({
        text: rendered,
        blocks: [
          { type: "section", text: { type: "plain_text", text: "Please check these." } },
          table,
          secondTable,
        ],
      }),
    ).toBe(`${rendered}\nTeam\tOwner\nPlatform\tAda`);
    expect(
      resolveSlackMessageText({
        text: "Please check these.",
        blocks: [
          { type: "section", text: { type: "plain_text", text: "Please check these." } },
          table,
          table,
        ],
      }),
    ).toBe(rendered);
  });

  it("expands a message prefix only when blocks before the table represent it", () => {
    const table = {
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Status" },
          { type: "raw_text", text: "Value" },
        ],
      ],
    };
    const section = { type: "section", text: { type: "plain_text", text: "Instructions" } };

    expect(resolveSlackMessageText({ text: "Status", blocks: [table, section] })).toBe(
      "Status\nStatus\tValue\nInstructions",
    );
    expect(
      resolveSlackMessageText({
        text: "Instructions",
        blocks: [{ type: "section", text: { type: "plain_text", text: "Instructions" } }, table],
      }),
    ).toBe("Instructions\nStatus\tValue");
  });

  it("does not deduplicate a short table found only inside surrounding words", () => {
    expect(
      resolveSlackMessageText({
        text: "please look good",
        attachments: [
          {
            blocks: [
              {
                type: "table",
                rows: [
                  [
                    { type: "raw_text", text: "ok" },
                    { type: "raw_text", text: "go" },
                  ],
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("please look good\nok\tgo");
  });

  it.each([
    {
      name: "space-separated sentence versus TSV row",
      text: "A B",
      cells: ["A", "B"],
      expected: "A B\nA\tB",
    },
    {
      name: "single cell inside a sentence",
      text: "Please check enabled",
      cells: ["enabled"],
      expected: "Please check enabled\nenabled",
    },
    {
      name: "cell extending the whole sentence",
      text: "A",
      cells: ["AB"],
      expected: "A\nAB",
    },
    {
      name: "sentence matching the first table cell",
      text: "A",
      cells: ["A", "B"],
      expected: "A\nA\tB",
    },
  ])("preserves table structure for $name", ({ text, cells, expected }) => {
    expect(
      resolveSlackMessageText({
        text,
        attachments: [
          {
            blocks: [
              {
                type: "table",
                rows: [cells.map((cell) => ({ type: "raw_text", text: cell }))],
              },
            ],
          },
        ],
      }),
    ).toBe(expected);
  });

  it("keeps top-level message text alongside native chart details", () => {
    const blocks = [
      {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [
            {
              name: "p95",
              data: [
                { label: "Mon", value: 250 },
                { label: "Tue", value: 230 },
              ],
            },
          ],
          axis_config: { categories: ["Mon", "Tue"] },
        },
      },
    ];

    expect(
      resolveSlackMessageText({
        text: "Here is the requested latency trend.",
        blocks,
      }),
    ).toBe(
      [
        "Here is the requested latency trend.",
        "Weekly latency (line chart)",
        "- p95: Mon: 250; Tue: 230",
      ].join("\n"),
    );
  });

  it.each([
    {
      name: "data table",
      text: "Pipeline report (table)",
      block: {
        type: "data_table",
        caption: "Pipeline report",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
      expected: "Pipeline report (table)\n- Account: Acme",
      deduplicatedText: "Pipeline report (table) - Account: Acme",
    },
    {
      name: "data visualization",
      text: "Weekly latency (line chart)",
      block: {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
          axis_config: { categories: ["Mon"] },
        },
      },
      expected: "Weekly latency (line chart)\n- p95: Mon: 250",
      deduplicatedText: "Weekly latency (line chart) - p95: Mon: 250",
    },
  ])(
    "preserves prefix expansion and whitespace-insensitive deduplication for a $name",
    ({ text, block, expected, deduplicatedText }) => {
      expect(resolveSlackMessageText({ text, blocks: [block] })).toBe(expected);
      expect(resolveSlackMessageText({ text: deduplicatedText, blocks: [block] })).toBe(
        deduplicatedText,
      );
    },
  );

  it("keeps legacy native-data comparison separate from an adjacent basic table", () => {
    const messageText = "Weekly latency (line chart) - p95: Mon: 250";
    expect(
      resolveSlackMessageText({
        text: messageText,
        blocks: [
          {
            type: "data_visualization",
            title: "Weekly latency",
            chart: {
              type: "line",
              series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
              axis_config: { categories: ["Mon"] },
            },
          },
          {
            type: "table",
            rows: [
              [
                { type: "raw_text", text: "Status" },
                { type: "raw_text", text: "Value" },
              ],
            ],
          },
        ],
      }),
    ).toBe(`${messageText}\nStatus\tValue`);
  });

  it("does not duplicate top-level text already represented before a chart", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Latency report" } },
      {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
          axis_config: { categories: ["Mon"] },
        },
      },
    ];

    expect(resolveSlackMessageText({ text: "Latency report", blocks })).toBe(
      "Latency report\nWeekly latency (line chart)\n- p95: Mon: 250",
    );
  });

  it("does not duplicate chart data when top-level text uses paragraph spacing", () => {
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: "Latency report" } },
      {
        type: "data_visualization",
        title: "Weekly latency",
        chart: {
          type: "line",
          series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
          axis_config: { categories: ["Mon"] },
        },
      },
    ];
    const messageText = "Latency report\n\nWeekly latency (line chart)\n- p95: Mon: 250";

    expect(resolveSlackMessageText({ text: messageText, blocks })).toBe(messageText);
  });
});
