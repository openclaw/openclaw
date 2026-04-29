import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import {
  encodeSlackModalPrivateMetadata,
  parseSlackModalPrivateMetadata,
} from "./modal-metadata.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";

describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "header", text: { type: "plain_text", text: "Deploy status" } },
      ] as never),
    ).toBe("Deploy status");
  });

  it("uses image alt text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "image", image_url: "https://example.com/image.png", alt_text: "Latency chart" },
      ] as never),
    ).toBe("Latency chart");
  });

  it("uses generic defaults for file and unknown blocks", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "file", source: "remote", external_id: "F123" },
      ] as never),
    ).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }] as never)).toBe(
      "Shared a Block Kit message",
    );
  });
});

describe("parseSlackBlocksInput", () => {
  it("returns undefined when blocks are missing", () => {
    expect(parseSlackBlocksInput(undefined)).toBeUndefined();
    expect(parseSlackBlocksInput(null)).toBeUndefined();
  });

  it("accepts blocks arrays", () => {
    const parsed = parseSlackBlocksInput([{ type: "divider" }]);
    expect(parsed).toEqual([{ type: "divider" }]);
  });

  it("accepts JSON blocks strings", () => {
    const parsed = parseSlackBlocksInput(
      '[{"type":"section","text":{"type":"mrkdwn","text":"hi"}}]',
    );
    expect(parsed).toEqual([{ type: "section", text: { type: "mrkdwn", text: "hi" } }]);
  });

  it("rejects invalid block payloads", () => {
    const cases = [
      {
        name: "invalid JSON",
        input: "{bad-json",
        expectedMessage: /valid JSON/i,
      },
      {
        name: "non-array payload",
        input: { type: "divider" },
        expectedMessage: /must be an array/i,
      },
      {
        name: "empty array",
        input: [],
        expectedMessage: /at least one block/i,
      },
      {
        name: "non-object block",
        input: ["not-a-block"],
        expectedMessage: /must be an object/i,
      },
      {
        name: "missing block type",
        input: [{}],
        expectedMessage: /non-empty string type/i,
      },
    ] as const;

    for (const testCase of cases) {
      expect(() => parseSlackBlocksInput(testCase.input), testCase.name).toThrow(
        testCase.expectedMessage,
      );
    }
  });
});

describe("resolveSlackReplyBlocks", () => {
  it("merges channel blocks with presentation and interactive reply blocks", () => {
    const blocks = resolveSlackReplyBlocks({
      text: "Choose a deploy target",
      channelData: {
        slack: {
          blocks: [
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: "release window" }],
            },
          ],
        },
      },
      presentation: {
        title: "Deploy",
        blocks: [
          { type: "text", text: "Pick a target." },
          {
            type: "buttons",
            buttons: [{ label: "Ship", value: "ship", style: "primary" }],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "select",
            placeholder: "Environment",
            options: [{ label: "Production", value: "prod" }],
          },
        ],
      },
    });

    expect(blocks).toEqual([
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "release window" }],
      },
      {
        type: "header",
        text: { type: "plain_text", text: "Deploy", emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Pick a target." },
      },
      expect.objectContaining({
        type: "actions",
        elements: [
          expect.objectContaining({
            type: "button",
            text: { type: "plain_text", text: "Ship", emoji: true },
            value: "ship",
            style: "primary",
          }),
        ],
      }),
      expect.objectContaining({
        type: "actions",
        elements: [
          expect.objectContaining({
            type: "static_select",
            placeholder: { type: "plain_text", text: "Environment", emoji: true },
            options: [
              {
                text: { type: "plain_text", text: "Production", emoji: true },
                value: "prod",
              },
            ],
          }),
        ],
      }),
    ]);
  });

  it("uses pre-rendered presentation blocks without rendering the source presentation twice", () => {
    const renderedPresentationBlocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "Rendered", emoji: true },
      },
    ];

    expect(
      resolveSlackReplyBlocks({
        channelData: {
          slack: {
            presentationBlocks: renderedPresentationBlocks,
          },
        },
        presentation: {
          title: "Source",
          blocks: [{ type: "text", text: "Do not duplicate." }],
        },
      }),
    ).toEqual(renderedPresentationBlocks);
  });
});

describe("parseSlackModalPrivateMetadata", () => {
  it("returns empty object for missing or invalid values", () => {
    expect(parseSlackModalPrivateMetadata(undefined)).toEqual({});
    expect(parseSlackModalPrivateMetadata("")).toEqual({});
    expect(parseSlackModalPrivateMetadata("{bad-json")).toEqual({});
  });

  it("parses known metadata fields", () => {
    expect(
      parseSlackModalPrivateMetadata(
        JSON.stringify({
          sessionKey: "agent:main:slack:channel:C1",
          channelId: "D123",
          channelType: "im",
          userId: "U123",
          ignored: "x",
        }),
      ),
    ).toEqual({
      sessionKey: "agent:main:slack:channel:C1",
      channelId: "D123",
      channelType: "im",
      userId: "U123",
    });
  });
});

describe("encodeSlackModalPrivateMetadata", () => {
  it("encodes only known non-empty fields", () => {
    expect(
      JSON.parse(
        encodeSlackModalPrivateMetadata({
          sessionKey: "agent:main:slack:channel:C1",
          channelId: "",
          channelType: "im",
          userId: "U123",
        }),
      ),
    ).toEqual({
      sessionKey: "agent:main:slack:channel:C1",
      channelType: "im",
      userId: "U123",
    });
  });

  it("throws when encoded payload exceeds Slack metadata limit", () => {
    expect(() =>
      encodeSlackModalPrivateMetadata({
        sessionKey: `agent:main:${"x".repeat(4000)}`,
      }),
    ).toThrow(/cannot exceed 3000 chars/i);
  });
});
