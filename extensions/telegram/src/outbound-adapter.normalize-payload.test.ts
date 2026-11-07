import {
  adaptMessagePresentationForChannel,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

type Payload = Parameters<NonNullable<typeof telegramOutbound.normalizePayload>>[0]["payload"];
const normalize = (payload: Payload) => telegramOutbound.normalizePayload?.({ cfg: {}, payload });
const buttons = (...items: MessagePresentationButton[]) => ({
  blocks: [{ type: "buttons" as const, buttons: items }],
});
const fallbackText = { text: "Pablo Daily Summary", replacesPayloadIndex: 0 };
const fallbackPayload = (telegram: Record<string, unknown>): Payload => ({
  fallbackText: { ...fallbackText },
  channelData: { telegram },
});

describe("telegramOutbound", () => {
  it.each([
    {
      name: "buttons without fallback",
      payload: {
        channelData: {
          telegram: { buttons: [[{ text: "Open task", url: "https://example.test/task" }]] },
        },
      },
    },
    {
      name: "unrelated metadata with fallback",
      payload: {
        fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
        channelData: { plugin: { traceId: "trace-1" } },
      },
    },
  ])("suppresses metadata-only $name", ({ payload }) => {
    expect(normalize(payload)).toBeNull();
  });

  it("merges all fallback adopters into the linked summary and keeps reactions separate", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      fallbackPayload({ reaction: { emoji: "+1", replyToId: "123" } }),
      fallbackPayload({ buttons: [[{ text: "Open task 1", callback_data: "one" }]] }),
      fallbackPayload({ buttons: [[{ text: "Open task 2", callback_data: "two" }]] }),
    ];
    const normalized = telegramOutbound.normalizePayloadBatch?.({
      cfg: {},
      payloads: payloads.map((payload, index) => ({
        index,
        payload: normalize(payload) ?? payload,
      })),
    });
    expect(normalized).toEqual([
      {
        text: "Pablo Daily Summary",
        fallbackText: { ...fallbackText },
        channelData: {
          telegram: {
            buttons: [
              [{ text: "Open task 1", callback_data: "one" }],
              [{ text: "Open task 2", callback_data: "two" }],
            ],
          },
        },
      },
      fallbackPayload({ reaction: { emoji: "+1", replyToId: "123" } }),
      null,
      null,
    ]);
  });
  it("preserves fallback labels after core capability adaptation", async () => {
    const label = "Open the workspace with the complete deployment instructions for production";
    const sourcePresentation = buttons(
      { label: "Continue", action: { type: "command", command: "/continue" } },
      { label, action: { type: "web-app", url: "https://example.com/app" } },
    );
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

  it.each(["native", "legacy"])("preserves %s buttons in mixed presentations", async (kind) => {
    const payload: Payload =
      kind === "native"
        ? {
            channelData: { telegram: { buttons: [[{ text: "Native", callback_data: "native" }]] } },
          }
        : { interactive: buttons({ label: "Legacy", value: "legacy" }) };
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Choose:", ...payload },
      presentation: buttons({ label: "Generic", value: "generic" }),
      ctx: { cfg: {} } as never,
    });
    expect(rendered).toMatchObject({
      text: "Choose:\n\n- Generic",
      channelData: {
        telegram: {
          buttons:
            kind === "native"
              ? [[{ text: "Native", callback_data: "native" }]]
              : [[{ text: "Legacy", callback_data: "legacy" }]],
        },
      },
    });
  });
  const islandText =
    'before <details><summary>More</summary>body</details> <tg-math-block>x^2</tg-math-block> <ul><li><input type="checkbox" checked/>done</li></ul>';
  it.each([false, true])("sanitizes rich default account=%s", (rich) => {
    const accounts = { "rich-bot": { richMessages: true } };
    const telegram = rich ? { defaultAccount: "rich-bot", accounts } : {};
    const sanitized = telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg: { channels: { telegram } },
      accountId: rich ? undefined : "default",
    });
    const expected = rich
      ? [
          "<details><summary>More</summary>",
          "<tg-math-block>x^2</tg-math-block>",
          '<input type="checkbox" checked/>',
        ]
      : ["**More**\n\nbody", "• done"];
    for (const text of expected) {
      expect(sanitized).toContain(text);
    }
    if (!rich) {
      expect(sanitized).not.toContain("<details>");
    }
  });

  it("advertises native details preservation only for rich accounts", () => {
    const preservesDetails = (telegram: { richMessages?: boolean }) =>
      telegramOutbound.preserveMarkdownDetails?.({
        cfg: { channels: { telegram } },
        accountId: "default",
      });
    expect(preservesDetails({ richMessages: true })).toBe(true);
    expect(preservesDetails({})).toBe(false);
  });
});
