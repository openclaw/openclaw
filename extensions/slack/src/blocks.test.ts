import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText, renderSlackBlockFallbackText } from "./blocks-fallback.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { parseSlackModalPrivateMetadata } from "./modal-metadata.js";

const text = (value: string, type = "plain_text") => ({ type, text: value });
const raw = (value: string) => text(value, "raw_text");
const richSection = (elements: unknown[]) => ({ type: "rich_text_section", elements });

describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    const blocks = [{ type: "header", text: text("Deploy status") }];
    expect(buildSlackBlocksFallbackText(blocks)).toBe("Deploy status");
  });

  it("preserves image title/alt precedence and formatting", () => {
    const block = { type: "image", alt_text: " Alt <@U123> ", title: text(" Title <@U123> ") };
    expect(renderSlackBlockFallbackText(block)).toBe("Alt &lt;@U123&gt;");
    expect(renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" })).toBe(
      "Alt &lt;@U123&gt;",
    );
    expect(renderSlackBlockFallbackText({ ...block, alt_text: "" })).toBe("Title &lt;@U123&gt;");
    expect(renderSlackBlockFallbackText({ ...block, title: null })).toBe("Alt &lt;@U123&gt;");
  });

  it("renders inbound table cells as bounded delimiter-safe TSV", () => {
    const table = {
      type: "table",
      rows: [
        [raw("Name"), { type: "raw_number", value: 42 }, raw("Note")],
        [
          {
            type: "rich_text",
            elements: [
              richSection([
                text("Ada", "text"),
                text(" ", "text"),
                { type: "user", user_id: "U123" },
                {
                  type: "future_container",
                  elements: [{ type: "future_leaf", text: " preserved " }],
                },
              ]),
            ],
          },
          { type: "raw_number", value: 7, text: "seven" },
          raw("A\tB\nC\\D"),
        ],
      ],
    };

    expect(renderSlackBlockFallbackText(table, { nativeDataFormat: "plain" })).toBe(
      ["Name\t42\tNote", "Ada <@U123> preserved \tseven\tA\\tB\\nC\\\\D"].join("\n"),
    );
    expect(renderSlackBlockFallbackText(table)).toBe(
      ["Name\t42\tNote", "Ada &lt;@U123&gt; preserved \tseven\tA\\tB\\nC\\\\D"].join("\n"),
    );
  });

  it("rejects inbound tables outside Slack's published row limit", () => {
    const rows = Array.from({ length: 101 }, () => [raw("cell")]);
    expect(renderSlackBlockFallbackText({ type: "table", rows })).toBeUndefined();
  });

  it("uses only visible action labels and select placeholders", () => {
    const fallback = buildSlackBlocksFallbackText([
      {
        type: "actions",
        block_id: "private-block-id",
        elements: [
          {
            type: "button",
            action_id: "private-action-id",
            text: text("Approve"),
            value: "private-button-value",
          },
          {
            type: "static_select",
            action_id: "private-select-id",
            placeholder: text("Choose owner"),
            options: [{ text: text("Secret option"), value: "private-option" }],
          },
        ],
      },
    ]);

    expect(fallback).toBe("Approve\nChoose owner");
    expect(fallback).not.toMatch(/private|Secret option/u);
  });

  it("renders section text and fields together", () => {
    expect(
      renderSlackBlockFallbackText({
        type: "section",
        text: text("Deploy status", "mrkdwn"),
        fields: [text("*Region*\nus-east-1", "mrkdwn"), text("Healthy")],
      }),
    ).toBe("Deploy status\n*Region*\nus-east-1\nHealthy");
  });

  it("renders rich text and context without hidden metadata", () => {
    const richTextBlock = {
      type: "rich_text",
      block_id: "private-block-id",
      elements: [
        richSection([
          text("Ask ", "text"),
          { type: "user", user_id: "U123" },
          text(" <!channel> in ", "text"),
          { type: "channel", channel_id: "C123" },
          text(" ", "text"),
          { type: "emoji", name: "wave" },
        ]),
        {
          type: "rich_text_list",
          elements: [
            richSection([text("First", "text")]),
            richSection([
              { type: "link", url: "https://example.com/private-target", text: "Second" },
              text(" for ", "text"),
              { type: "usergroup", usergroup_id: "S123" },
              text(" ", "text"),
              { type: "broadcast", range: "here" },
            ]),
          ],
        },
        { type: "future_container", elements: [text("hidden-future-text", "text")] },
      ],
    };
    const richText = renderSlackBlockFallbackText(richTextBlock);
    const context = renderSlackBlockFallbackText({
      type: "context",
      elements: [
        text("Updated now", "mrkdwn"),
        { type: "image", alt_text: "Green status", image_url: "https://example.com/secret" },
      ],
    });

    expect(richText).toBe(
      "Ask &lt;@U123&gt; &lt;!channel&gt; in &lt;#C123&gt; :wave:\nFirst\nSecond for &lt;!subteam^S123&gt; &lt;!here&gt;",
    );
    expect(renderSlackBlockFallbackText(richTextBlock, { nativeDataFormat: "plain" })).toBe(
      richText,
    );
    expect(renderSlackBlockFallbackText(richTextBlock, { nativeReferenceFormat: "plain" })).toBe(
      "Ask <@U123> &lt;!channel&gt; in <#C123> :wave:\nFirst\nSecond for <!subteam^S123> <!here>",
    );
    expect(richText).not.toMatch(/private-block-id|private-target|hidden-future-text/u);
    expect(context).toBe("Updated now Green status");
    expect(context).not.toContain("secret");
  });

  it("selects plain or mrkdwn-safe native data text explicitly", () => {
    const table = {
      type: "data_table",
      caption: "<!channel> pipeline",
      rows: [[raw("Owner")], [raw("<@U123>")]],
    };

    expect(renderSlackBlockFallbackText(table, { nativeDataFormat: "plain" })).toBe(
      "<!channel> pipeline (table)\n- Owner: <@U123>",
    );
    expect(renderSlackBlockFallbackText(table, { nativeDataFormat: "mrkdwn-safe" })).toBe(
      "&lt;!channel&gt; pipeline (table)\n- Owner: &lt;@U123&gt;",
    );
  });

  it("uses generic defaults for file and unknown blocks", () => {
    const blocks = [{ type: "file", source: "remote", external_id: "F123" }];
    expect(buildSlackBlocksFallbackText(blocks)).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }])).toBe("Shared a Block Kit message");
    expect(renderSlackBlockFallbackText({ type: "video" })).toBe("Shared a video");
  });
});

it("parseSlackBlocksInput rejects invalid block payloads", () => {
  for (const [input, message] of [
    ["{bad-json", /valid JSON/i],
    [{ type: "divider" }, /must be an array/i],
    [[], /at least one block/i],
    [["not-a-block"], /must be an object/i],
    [[{}], /non-empty string type/i],
  ] as const) {
    expect(() => parseSlackBlocksInput(input)).toThrow(message);
  }
});

it("parseSlackModalPrivateMetadata returns empty object for missing or invalid values", () => {
  expect(parseSlackModalPrivateMetadata(undefined)).toStrictEqual({});
  expect(parseSlackModalPrivateMetadata("")).toStrictEqual({});
  expect(parseSlackModalPrivateMetadata("{bad-json")).toStrictEqual({});
});
