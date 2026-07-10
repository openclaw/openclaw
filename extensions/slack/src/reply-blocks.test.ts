import { describe, expect, it } from "vitest";
import { resolveSlackReplyBlockResolution, resolveSlackReplyText } from "./reply-blocks.js";

describe("resolveSlackReplyText", () => {
  it("includes complete portable table data in Slack accessibility text", () => {
    expect(
      resolveSlackReplyText({
        text: "Pipeline summary",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline",
              headers: ["Account", "Stage", "ARR"],
              rows: [
                ["Acme", "Won", 125000],
                ["Globex", "Review", 82000],
              ],
            },
          ],
        },
      }),
    ).toBe(
      "Pipeline summary\n\nPipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
    );
  });

  it("keeps raw table values literal without changing authored Slack text", () => {
    expect(
      resolveSlackReplyText({
        text: "Intentional <!here>",
        presentation: {
          title: "Report <@U999>",
          blocks: [
            {
              type: "table",
              caption: "<!channel> *report*",
              headers: ["Owner_name"],
              rows: [["<@U123> & <https://example.com>"]],
            },
          ],
        },
      }),
    ).toBe(
      "Intentional <!here>\n\nReport &lt;@U999&gt;\n\n&lt;!channel&gt; \\*report\\* (table)\n- Owner\\_name: &lt;@U123&gt; &amp; &lt;https://example.com&gt;",
    );
  });

  it("keeps plain-text controls literal when they accompany structured data", () => {
    expect(
      resolveSlackReplyText({
        presentation: {
          blocks: [
            { type: "table", caption: "Data", headers: ["Value"], rows: [[1]] },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Notify <!here>",
                  url: "https://example.com/?a=1&b=2",
                },
                {
                  label: "Run <@U1>",
                  action: { type: "command", command: "/say <!channel>" },
                },
              ],
            },
            {
              type: "select",
              placeholder: "Owner <!channel>",
              options: [{ label: "<@U2>", value: "owner" }],
            },
          ],
        },
      }),
    ).toBe(
      [
        "Data (table)",
        "- Value: 1",
        "",
        "- Notify &lt;!here&gt;: https://example.com/?a=1&amp;b=2",
        "- Run &lt;@U1&gt;: `/say &lt;!channel&gt;`",
        "",
        "Owner &lt;!channel&gt;:",
        "- &lt;@U2&gt;",
      ].join("\n"),
    );
  });

  it("marks non-native portable tables for strict text-only delivery", () => {
    const payload = {
      channelData: { slack: { blocks: [{ type: "divider" }] } },
      presentation: {
        blocks: [
          {
            type: "table" as const,
            caption: "Large pipeline",
            headers: ["Account"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `account-${String(index)} ${"x".repeat(110)}`,
            ]),
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
        ],
      },
    };

    expect(resolveSlackReplyBlockResolution(payload)).toEqual({
      usesTableTextFallback: true,
    });
    expect(resolveSlackReplyText(payload)).toContain("- Account: account-99");
  });
});
