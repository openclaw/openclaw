import { adaptMessagePresentationForChannel } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound normalizePayload", () => {
  it("suppresses metadata-only button payloads when no fallback text exists", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        channelData: {
          telegram: {
            buttons: [[{ text: "Open task", url: "https://example.test/task" }]],
          },
        },
      },
    });

    expect(normalized).toBeNull();
  });

  it("suppresses unrelated metadata-only payloads even when fallback text exists", () => {
    const normalized = telegramOutbound.normalizePayload?.({
      cfg: {} as never,
      payload: {
        fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
        channelData: { plugin: { traceId: "trace-1" } },
      },
    });

    expect(normalized).toBeNull();
  });

  it("merges all fallback adopters into the linked summary and keeps reactions separate", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { reaction: { emoji: "+1", replyToId: "123" } } },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task 1", callback_data: "one" }]] } },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { buttons: [[{ text: "Open task 2", callback_data: "two" }]] } },
      },
    ];
    const normalizedPayloads = payloads.map(
      (payload) => telegramOutbound.normalizePayload?.({ cfg: {} as never, payload }) ?? payload,
    );
    const normalized = telegramOutbound.normalizePayloadBatch?.({
      cfg: {} as never,
      payloads: normalizedPayloads.map((payload, index) => ({ index, payload })),
    });

    expect(normalized).toEqual([
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: {
          telegram: {
            buttons: [
              [{ text: "Open task 1", callback_data: "one" }],
              [{ text: "Open task 2", callback_data: "two" }],
            ],
          },
        },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { reaction: { emoji: "+1", replyToId: "123" } } },
      },
      null,
      null,
    ]);
  });
});

describe("telegramOutbound presentation", () => {
  it("preserves fallback labels after core capability adaptation", async () => {
    const label = "Open the workspace with the complete deployment instructions for production";
    const sourcePresentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            { label: "Continue", action: { type: "command" as const, command: "/continue" } },
            { label, action: { type: "web-app" as const, url: "https://example.com/app" } },
          ],
        },
      ],
    };
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { presentationTextMode: "fallback" },
      presentation: adaptMessagePresentationForChannel({
        presentation: sourcePresentation,
        capabilities: telegramOutbound.presentationCapabilities,
      }),
      sourcePresentation,
      ctx: { cfg: {}, to: "-10012345" } as never,
    });

    expect(rendered?.text).toContain(label);
    expect(rendered?.text).toContain("https://example.com/app");
    expect(rendered?.channelData?.telegram).toEqual({
      buttons: [[{ text: "Continue", callback_data: "tgcmd:/continue" }]],
    });
  });

  it("preserves explicit Telegram buttons when rendering presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Use native buttons:",
        channelData: {
          telegram: {
            buttons: [[{ text: "Native", callback_data: "native" }]],
          },
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: { cfg: {} } as never,
    });

    expect(rendered?.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Native", callback_data: "native" }]],
    });
    expect(rendered?.text).toBe("Use native buttons:\n\n- Generic");
  });

  it("preserves legacy interactive buttons when rendering mixed presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Choose:",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: { cfg: {} } as never,
    });
    expect(rendered?.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Legacy", callback_data: "legacy" }]],
    });

    expect(rendered?.text).toBe("Choose:\n\n- Generic");
  });
});

describe("telegramOutbound.sanitizeText", () => {
  const islandText =
    'before <details><summary>More</summary>body</details> <tg-math-block>x^2</tg-math-block> <ul><li><input type="checkbox" checked/>done</li></ul>';

  it("converts HTML to plain markers for non-rich accounts", () => {
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg: { channels: { telegram: {} } } as never,
      accountId: "default",
    });
    expect(sanitized).not.toContain("<details>");
    expect(sanitized).toContain("**More**\n\nbody");
    expect(sanitized).toContain("• done");
  });

  it("resolves the effective named default account when accountId is omitted", () => {
    const cfg = {
      channels: {
        telegram: {
          defaultAccount: "rich-bot",
          accounts: { "rich-bot": { richMessages: true } },
        },
      },
    } as never;
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg,
    });
    expect(sanitized).toContain("<details><summary>More</summary>");
    expect(sanitized).toContain("<tg-math-block>x^2</tg-math-block>");
    expect(sanitized).toContain('<input type="checkbox" checked/>');
  });

  it("advertises native details preservation only for rich accounts", () => {
    expect(
      telegramOutbound.preserveMarkdownDetails?.({
        cfg: { channels: { telegram: { richMessages: true } } } as never,
        accountId: "default",
      }),
    ).toBe(true);
    expect(
      telegramOutbound.preserveMarkdownDetails?.({
        cfg: { channels: { telegram: {} } } as never,
        accountId: "default",
      }),
    ).toBe(false);
  });
});
