// Line tests cover message cards plugin behavior.
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  messageAction,
  normalizeLineAction,
  normalizeLineMessage,
  truncateLineActionLabel,
  type Action,
} from "./actions.js";
import { handleLineCardCommand } from "./card-command.js";
import { createActionCard, createInfoCard } from "./flex-templates/basic-cards.js";
import {
  createAppleTvRemoteCard,
  createDeviceControlCard,
  createMediaPlayerCard,
} from "./flex-templates/media-control-cards.js";
import { createEventCard } from "./flex-templates/schedule-cards.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineTemplateMessagePayload } from "./types.js";

function renderTemplate(payload: LineTemplateMessagePayload): messagingApi.TemplateMessage {
  const message = buildTemplateMessageFromPayload(payload);
  if (message?.type !== "template") {
    throw new Error(`Expected a LINE template, received ${message?.type ?? "nothing"}`);
  }
  return message;
}

const expectedUnavailableCallbackAction = {
  type: "message",
  label: "Unavailable",
  text: "Action unavailable: callback data exceeds LINE's limit.",
};

const expectedUnavailableLink = {
  type: "message",
  label: "Unavailable",
  text: "Link unavailable: URL exceeds LINE's limit.",
};

const expectedUnavailableMessageText = {
  type: "message",
  label: "Unavailable",
  text: "Action unavailable: message text exceeds LINE's limit.",
};

const loneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const lineFlexCardCommandScenarios = [
  {
    kind: "info",
    args: (body: string) => `info "Title" "${body}"`,
    expectedAltText: (body: string) => `Title: ${body}`,
  },
  {
    kind: "image",
    args: (body: string) => `image "Title" "${body}" --url https://example.test/image.png`,
    expectedAltText: (body: string) => `Title: ${body}`,
  },
] as const;

async function runLineFlexCardCommand(
  args: string,
): Promise<{ altText: string; contents: messagingApi.FlexContainer }> {
  const result = (await handleLineCardCommand(args)) as {
    channelData: {
      line: { flexMessage: { altText: string; contents: messagingApi.FlexContainer } };
    };
  };
  return result.channelData.line.flexMessage;
}

function resolveLineFlexCardActions(message: {
  contents: messagingApi.FlexContainer;
}): messagingApi.Action[] {
  if (message.contents.type !== "bubble") {
    throw new Error("Expected LINE Flex action card to render a bubble");
  }
  const footer = expectDefined(message.contents.footer, "LINE flex-message footer");
  return footer.contents.map((component) => {
    if (component.type !== "button") {
      throw new Error("Expected LINE Flex action card footer to contain buttons");
    }
    return component.action;
  });
}

function cardButtons(component: messagingApi.FlexComponent | undefined): messagingApi.FlexButton[] {
  if (component?.type === "box") {
    return component.contents.flatMap(cardButtons);
  }
  return component?.type === "button" ? [component] : [];
}

describe("LINE template payload limits", () => {
  it("keeps the fallback confirm alt text Unicode-safe", () => {
    const message = renderTemplate({
      type: "confirm",
      text: `${"x".repeat(1499)}😀`,
      confirmLabel: "Yes",
      confirmData: "Yes",
      cancelLabel: "No",
      cancelData: "No",
    });
    expect(message.altText).toBe("x".repeat(1499));
    expect(loneHighSurrogate.test(message.altText)).toBe(false);
  });

  it.each([
    {
      title: undefined,
      thumbnailImageUrl: "https://example.com/thumb.jpg",
      text: "x".repeat(150),
      expected: "x".repeat(60),
    },
    {
      title: "Title",
      thumbnailImageUrl: undefined,
      text: `😀${"\u0301".repeat(59)}`,
      expected: `😀${"\u0301".repeat(58)}`,
    },
  ])(
    "bounds carousel text with title $title and image $thumbnailImageUrl",
    ({ title, thumbnailImageUrl, text, expected }) => {
      const message = renderTemplate({
        type: "carousel",
        columns: [{ title, thumbnailImageUrl, text, actions: [{ type: "message", label: "OK" }] }],
      });
      expect(message.template).toMatchObject({ columns: [{ text: expected }] });
    },
  );
});

describe("flex cards", () => {
  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    const footer = card.footer as { contents: Array<{ text: string }> };
    expect(expectDefined(footer.contents[0], "info-card footer content").text).toBe("Footer text");
  });

  it("limits device controls to 6", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: Array.from({ length: 10 }, (_, i) => ({
        label: `Control ${i}`,
        data: `action=${i}`,
      })),
    });

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBeLessThanOrEqual(3);
  });

  it("keeps event-card optional fields together", () => {
    const card = createEventCard({
      title: "Team Offsite",
      date: "February 15, 2026",
      time: "9:00 AM - 5:00 PM",
      location: "Mountain View Office",
      description: "Annual team building event",
    });

    expect(card.size).toBe("mega");
    const body = card.body as { contents: Array<{ type: string }> };
    expect(body.contents).toHaveLength(3);
  });
});

describe("action label/data surrogate-safe truncation", () => {
  // 19 ASCII chars + 😀 (U+1F600, two UTF-16 code units) = 21 code units; a raw
  // .slice(0, 20) would keep the first 19 chars plus the lone high surrogate.
  const labelWithEmoji = "1234567890123456789😀";

  it("messageAction drops a half emoji instead of leaving a lone surrogate", () => {
    const action = messageAction(labelWithEmoji) as { label: string };

    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
  });

  it("datetime picker normalization preserves labels and disables overlong callback data", () => {
    const exactData = `${"d".repeat(298)}😀`;
    const overlongData = `${"d".repeat(299)}😀`;
    const action = normalizeLineAction({
      type: "datetimepicker",
      label: labelWithEmoji,
      data: "data",
      mode: "datetime",
    }) as { label: string };
    const exact = normalizeLineAction({
      type: "datetimepicker",
      label: "Pick",
      data: exactData,
      mode: "datetime",
    }) as { data: string };
    const unavailable = normalizeLineAction({
      type: "datetimepicker",
      label: "Pick",
      data: overlongData,
      mode: "datetime",
    });

    expect(exactData).toHaveLength(300);
    expect(overlongData).toHaveLength(301);
    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
    expect(exact.data).toBe(exactData);
    expect(unavailable).toEqual(expectedUnavailableCallbackAction);
  });

  it.each([
    { kind: "message", data: "/status", expected: { type: "message", text: "/status" } },
    {
      kind: "postback",
      data: "action=status",
      expected: { type: "postback", data: "action=status" },
    },
    {
      kind: "uri",
      data: "https://example.test/status",
      expected: { type: "uri", uri: "https://example.test/status" },
    },
  ])("/card action preserves 40-character $kind labels", async ({ data, expected }) => {
    const label = "x".repeat(40);
    const message = await runLineFlexCardCommand(
      `action "Menu" "Body" --actions "${label}|${data},${label}y|${data}"`,
    );
    expect(resolveLineFlexCardActions(message)).toMatchObject([
      { ...expected, label },
      { ...expected, label },
    ]);
  });

  it.each(lineFlexCardCommandScenarios)(
    "/card $kind preserves provider-valid Flex alternative text",
    async (scenario) => {
      const body = "a".repeat(1200);
      const message = await runLineFlexCardCommand(scenario.args(body));

      expect(message.altText).toBe(scenario.expectedAltText(body));
    },
  );

  it("device control postback labels count grapheme clusters", () => {
    const label = `${"x".repeat(17)}😀`;
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: [{ label, data: "extra" }],
    });
    const extraAction = cardButtons(card.footer)
      .map((button) => button.action)
      .find((action) => action.type === "postback" && action.data === "extra");

    expect(extraAction?.label).toBe(label);
    expect(loneHighSurrogate.test(extraAction?.label ?? "")).toBe(false);
  });

  it("buttons template payload visibly disables overlong postback data", () => {
    const template = buildTemplateMessageFromPayload({
      type: "buttons",
      text: "Pick",
      actions: [{ type: "postback", label: "Open", data: `action=open&token=${"x".repeat(300)}` }],
    });
    const message = expectDefined(template, "buttons template message");
    if (message.type !== "template" || message.template.type !== "buttons") {
      throw new Error("expected buttons template");
    }
    const buttonsTemplate = message.template;

    expect(buttonsTemplate.actions[0]).toEqual(expectedUnavailableCallbackAction);
  });

  it("normalizes raw template actions at the outbound message boundary", () => {
    const oversizedPostback: Action = {
      type: "postback",
      label: "Open",
      data: "x".repeat(301),
    };
    const oversizedUri: Action = {
      type: "uri",
      label: "Open",
      uri: `https://e.example/?q=${"x".repeat(1200)}`,
    };

    const buttons = normalizeLineMessage({
      type: "template",
      altText: "Pick",
      template: {
        type: "buttons",
        text: "Pick",
        actions: [oversizedPostback],
        defaultAction: oversizedUri,
      },
    });
    expect(buttons).toMatchObject({
      template: {
        actions: [expectedUnavailableCallbackAction],
        defaultAction: expectedUnavailableLink,
      },
    });

    const carousel = normalizeLineMessage({
      type: "template",
      altText: "Pick",
      template: {
        type: "carousel",
        columns: [{ text: "Pick", actions: [oversizedPostback], defaultAction: oversizedUri }],
      },
    });
    expect(carousel).toMatchObject({
      template: {
        columns: [
          {
            actions: [expectedUnavailableCallbackAction],
            defaultAction: expectedUnavailableLink,
          },
        ],
      },
    });
  });

  it("normalizes every length-constrained raw action field", () => {
    expect(
      normalizeLineAction({
        type: "uri",
        label: "Open",
        uri: "https://e.example",
        altUri: { desktop: `https://e.example/?q=${"x".repeat(1200)}` },
      }),
    ).toEqual(expectedUnavailableLink);

    const postback = normalizeLineAction({
      type: "postback",
      label: "Open",
      data: "action=open",
      displayText: "d".repeat(301),
    });
    expect(postback).toMatchObject({
      displayText: "d".repeat(300),
    });

    expect(normalizeLineAction({ type: "message", label: "Open", text: "x".repeat(301) })).toEqual(
      expectedUnavailableMessageText,
    );
    expect(
      normalizeLineAction({
        type: "postback",
        label: "Open",
        data: "action=open",
        fillInText: "x".repeat(301),
      }),
    ).toEqual(expectedUnavailableMessageText);
    expect(
      normalizeLineAction({
        type: "postback",
        label: "Open",
        data: "action=open",
        text: "x".repeat(301),
      }),
    ).toEqual(expectedUnavailableMessageText);
    const emojiText = "😀".repeat(300);
    expect(messageAction("Open", emojiText)).toMatchObject({ text: emojiText });
    const familyEmoji = "👨‍👩‍👧‍👦";
    expect(truncateLineActionLabel(familyEmoji.repeat(3))).toBe(familyEmoji.repeat(2));
    expect(truncateLineActionLabel(`👩${"‍👩".repeat(10)}`)).toBe("…");
    expect(messageAction("Open", familyEmoji.repeat(43))).toEqual(expectedUnavailableMessageText);
    expect(messageAction("Open", familyEmoji.repeat(42))).toMatchObject({
      text: familyEmoji.repeat(42),
    });
    expect(
      normalizeLineAction({
        type: "clipboard",
        label: "Copy",
        clipboardText: "x".repeat(1001),
      }),
    ).toEqual({
      type: "message",
      label: "Unavailable",
      text: "Action unavailable: clipboard text exceeds LINE's limit.",
    });
  });

  it("normalizes action cards and raw Flex actions at the outbound boundary", () => {
    const oversizedUri: Action = {
      type: "uri",
      label: "Open",
      uri: `https://e.example/?q=${"x".repeat(1200)}`,
    };
    const oversizedPostback: Action = {
      type: "postback",
      label: "Open",
      data: "x".repeat(301),
    };

    const card = createActionCard("Title", "Body", [oversizedPostback]);
    const button = (card.footer as { contents: Array<{ action: Action }> }).contents[0];
    expect(button?.action).toEqual(expectedUnavailableCallbackAction);

    const validLongLabel = "x".repeat(40);
    const labeledCard = createActionCard("Title", "Body", [
      { type: "message", label: validLongLabel, text: "Open" },
    ]);
    const labeledButton = (labeledCard.footer as { contents: Array<{ action: Action }> })
      .contents[0];
    expect(labeledButton?.action.label).toBe(validLongLabel);

    const normalized = normalizeLineMessage({
      type: "flex",
      altText: "Image and event",
      contents: {
        type: "bubble",
        hero: { type: "image", url: "https://e.example/image.jpg", action: oversizedUri },
        body: {
          type: "box",
          layout: "vertical",
          action: oversizedUri,
          contents: [{ type: "text", text: "Event", action: oversizedPostback }],
        },
      },
    });
    expect(normalized).toMatchObject({
      contents: {
        hero: { type: "image", url: "https://e.example/image.jpg" },
        body: {
          contents: [
            { type: "text", text: "Event" },
            {
              type: "text",
              text: `${expectedUnavailableLink.text}\n${expectedUnavailableCallbackAction.text}`,
            },
          ],
        },
      },
    });
    expect(JSON.stringify(normalized)).not.toContain('"action":');
  });

  it("media control cards visibly disable overlong opaque callbacks", () => {
    const overlongData = `${"d".repeat(299)}😀`;
    const card = createMediaPlayerCard({
      title: "Track",
      controls: {
        previous: { data: overlongData },
        play: { data: overlongData },
        pause: { data: overlongData },
        next: { data: overlongData },
      },
    });
    const actions = cardButtons(card.footer).map((button) => button.action);

    expect(actions).toHaveLength(4);
    for (const action of actions) {
      expect(action).toEqual(expectedUnavailableCallbackAction);
    }
  });

  it("Apple TV controls visibly disable overlong opaque callbacks", () => {
    const overlongData = `${"d".repeat(299)}😀`;
    const card = createAppleTvRemoteCard({
      deviceName: "TV",
      actionData: {
        up: overlongData,
        down: overlongData,
        left: overlongData,
        right: overlongData,
        select: overlongData,
        menu: overlongData,
        home: overlongData,
        play: overlongData,
        pause: overlongData,
        volumeUp: overlongData,
        volumeDown: overlongData,
        mute: overlongData,
      },
    });
    const actions = cardButtons(card.body).map((button) => button.action);

    expect(actions).toHaveLength(12);
    for (const action of actions) {
      expect(action).toEqual(expectedUnavailableCallbackAction);
    }
  });
});
