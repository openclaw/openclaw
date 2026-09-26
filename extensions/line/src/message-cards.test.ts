// Line tests cover message cards plugin behavior.
import type { messagingApi } from "@line/bot-sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  messageAction,
  normalizeLineAction,
  normalizeLineMessage,
  postbackAction,
  truncateLineActionLabel,
  uriAction,
  type Action,
} from "./actions.js";
import { handleLineCardCommand } from "./card-command.js";
import {
  createActionCard,
  createImageCard,
  createInfoCard,
  createListCard,
} from "./flex-templates/basic-cards.js";
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
  {
    kind: "action",
    args: (body: string) => `action "Title" "${body}" --actions "Open|ok"`,
    expectedAltText: (body: string) => `Title: ${body}`,
  },
  {
    kind: "list",
    args: (body: string) => `list "Title" "${body}|Description"`,
    expectedAltText: (body: string) => `Title: ${body}`,
  },
  {
    kind: "receipt",
    args: (body: string) => `receipt "Title" "${body}:$1" --total "$1"`,
    expectedAltText: (body: string) => `Title: ${body} $1`,
  },
] as const;

const lineTemplateMessageScenarios = [
  {
    kind: "confirm",
    create: (altText: string) =>
      renderTemplate({
        type: "confirm",
        text: "q".repeat(300),
        confirmLabel: "Yes",
        confirmData: "Yes",
        cancelLabel: "No",
        cancelData: "No",
        altText,
      }),
    bodyLimit: 240,
  },
  {
    kind: "buttons",
    create: (altText: string) =>
      renderTemplate({
        type: "buttons",
        title: "Menu",
        text: "b".repeat(200),
        actions: [{ type: "message", label: "Open" }],
        altText,
      }),
    bodyLimit: 60,
  },
  {
    kind: "carousel",
    create: (altText: string) =>
      renderTemplate({
        type: "carousel",
        columns: [{ text: "c".repeat(150), actions: [{ type: "message", label: "Open" }] }],
        altText,
      }),
    bodyLimit: 120,
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

  it.each([undefined, ""])("caps titleless buttons text when the title is %s", (title) => {
    const message = renderTemplate({
      type: "buttons",
      title,
      text: "x".repeat(200),
      actions: [{ type: "message", label: "OK" }],
    });
    expect(message.template).toMatchObject({ text: "x".repeat(160) });
    expect(message.template).not.toHaveProperty("title");
    expect(message.altText).toBe("x".repeat(200));
  });

  it("caps buttons actions at four", () => {
    const message = renderTemplate({
      type: "buttons",
      title: "Title",
      text: "Text",
      actions: Array.from({ length: 6 }, (_, index) => ({
        type: "message",
        label: `Button ${index}`,
      })),
    });
    if (message.template.type !== "buttons") {
      throw new Error("Expected buttons template");
    }
    expect(message.template.actions).toHaveLength(4);
  });

  it("bounds a button title without splitting its Unicode text", () => {
    const message = renderTemplate({
      type: "buttons",
      title: `${"x".repeat(39)}😀`,
      text: "Text",
      actions: [{ type: "message", label: "OK" }],
    });
    expect(message.template).toMatchObject({ title: "x".repeat(39) });
  });

  it.each([
    { title: " ", thumbnailImageUrl: undefined, text: "x".repeat(150), expected: "x".repeat(60) },
    {
      title: undefined,
      thumbnailImageUrl: "https://example.com/thumb.jpg",
      text: "x".repeat(150),
      expected: "x".repeat(60),
    },
    {
      title: "Title",
      thumbnailImageUrl: undefined,
      text: `${"x".repeat(59)}👨‍👩‍👧‍👦after`,
      expected: "x".repeat(59),
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

  it("bounds carousel titles without splitting a surrogate pair", () => {
    const message = renderTemplate({
      type: "carousel",
      columns: [
        { title: `${"x".repeat(39)}😀`, text: "Text", actions: [{ type: "message", label: "OK" }] },
      ],
    });
    expect(message.template).toMatchObject({ columns: [{ title: "x".repeat(39) }] });
  });
});

describe("flex cards", () => {
  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    const footer = card.footer as { contents: Array<{ text: string }> };
    expect(expectDefined(footer.contents[0], "info-card footer content").text).toBe("Footer text");
  });

  it("limits list items to 8", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}` }));
    const card = createListCard("List", items);

    const body = card.body as { contents: Array<{ type: string; contents?: unknown[] }> };
    const listBox = body.contents[2] as { contents: unknown[] };
    expect(listBox.contents.length).toBe(8);
  });

  it("includes image-card body text when provided", () => {
    const card = createImageCard("https://example.com/img.jpg", "Title", "Body text");

    const body = card.body as { contents: Array<{ text: string }> };
    expect(body.contents.length).toBe(2);
    expect(expectDefined(body.contents[1], "image-card body content").text).toBe("Body text");
  });

  it("limits action-card actions to 4", () => {
    const actions = Array.from({ length: 6 }, (_, i) => ({
      label: `Action ${i}`,
      action: { type: "message" as const, label: `A${i}`, text: `action${i}` },
    }));
    const card = createActionCard("Title", "Body", actions);

    const footer = card.footer as { contents: unknown[] };
    expect(footer.contents.length).toBe(4);
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

  it("postbackAction preserves valid grapheme labels but disables overlong callback data", () => {
    const exactData = `${"d".repeat(298)}😀`;
    const overlongData = `${"d".repeat(299)}😀`;
    const action = postbackAction(labelWithEmoji, "data") as { label: string };
    const exact = postbackAction("Label", exactData) as { data: string };
    const unavailable = postbackAction("Label", overlongData);

    expect(exactData).toHaveLength(300);
    expect(overlongData).toHaveLength(301);
    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(action.label)).toBe(false);
    expect(exact.data).toBe(exactData);
    expect(unavailable).toEqual(expectedUnavailableCallbackAction);
  });

  it("postbackAction truncates displayText by grapheme cluster but keeps undefined", () => {
    const displayText = `${"t".repeat(300)}😀`;
    const withDisplay = postbackAction("Label", "data", displayText) as {
      displayText?: string;
    };
    const withoutDisplay = postbackAction("Label", "data") as { displayText?: string };

    expect(withDisplay.displayText).toBe("t".repeat(300));
    expect(loneHighSurrogate.test(withDisplay.displayText ?? "")).toBe(false);
    expect(withoutDisplay.displayText).toBeUndefined();
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

  it("/card action command visibly disables overlong callback data", async () => {
    const message = await runLineFlexCardCommand(
      `action "Menu" "Body" --actions "${labelWithEmoji}|k=${"d".repeat(297)}😀"`,
    );
    const action = resolveLineFlexCardActions(message)[0];

    expect(action).toEqual(expectedUnavailableCallbackAction);
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

  it("/card action preserves Unicode labels without splitting the 40-grapheme boundary", async () => {
    const label = `${"x".repeat(39)}😀`;
    const message = await runLineFlexCardCommand(
      `action "Menu" "Body" --actions "${label}|/status"`,
    );
    const action = expectDefined(
      resolveLineFlexCardActions(message)[0],
      "LINE flex-message footer action",
    );

    expect(action.label).toBe(label);
    expect(loneHighSurrogate.test(action.label ?? "")).toBe(false);
  });

  it("/card buttons retains the template-specific 20-character action label limit", async () => {
    const label = "x".repeat(40);
    const result = (await handleLineCardCommand(
      `buttons "Menu" "Body" --actions "${label}|/status"`,
    )) as {
      channelData: {
        line: { templateMessage: Parameters<typeof buildTemplateMessageFromPayload>[0] };
      };
    };
    const message = expectDefined(
      buildTemplateMessageFromPayload(result.channelData.line.templateMessage),
      "LINE buttons template message",
    );
    if (message.type !== "template" || message.template.type !== "buttons") {
      throw new Error(`expected a LINE buttons template, received ${message.type}`);
    }

    expect(message.template.actions).toMatchObject([{ type: "message", label: "x".repeat(20) }]);
  });

  it("/card action visibly disables an oversized URI at the Flex action owner", async () => {
    const uri = `https://example.test/${"u".repeat(1_000)}`;
    const message = await runLineFlexCardCommand(`action "Menu" "Body" --actions "Open|${uri}"`);
    expect(resolveLineFlexCardActions(message)[0]).toEqual(expectedUnavailableLink);
  });

  it.each(lineFlexCardCommandScenarios)(
    "/card $kind preserves provider-valid Flex alternative text",
    async (scenario) => {
      const body = "a".repeat(1200);
      const message = await runLineFlexCardCommand(scenario.args(body));

      expect(message.altText).toBe(scenario.expectedAltText(body));
    },
  );

  it("/card receipt bounds alternative text without splitting a Unicode surrogate pair", async () => {
    const body = `${"a".repeat(1492)}😀 overflow`;
    const { altText } = await runLineFlexCardCommand(`receipt "Title" "${body}:$1" --total "$1"`);

    expect(altText).toBe(`Title: ${"a".repeat(1492)}`);
    expect(loneHighSurrogate.test(altText)).toBe(false);
  });

  it.each(lineTemplateMessageScenarios)(
    "preserves provider-valid $kind alternative text without changing inner text limits",
    (scenario) => {
      const altText = "a".repeat(1200);
      const message = scenario.create(altText);

      expect(message.altText).toBe(altText);
      if ("bodyLimit" in scenario) {
        const template = message.template as {
          text?: string;
          columns?: Array<{ text?: string }>;
        };
        expect((template.text ?? template.columns?.[0]?.text)?.length).toBe(scenario.bodyLimit);
      }
    },
  );

  it.each(lineTemplateMessageScenarios)(
    "bounds $kind alternative text at the provider's Unicode-safe 1500-unit limit",
    (scenario) => {
      const message = scenario.create(`${"a".repeat(1499)}😀 overflow`);

      expect(message.altText).toBe("a".repeat(1499));
      expect(loneHighSurrogate.test(message.altText)).toBe(false);
    },
  );

  it("media control postback labels count grapheme clusters", () => {
    const card = createMediaPlayerCard({
      title: "Track",
      controls: {
        play: { data: "play" },
      },
      extraActions: [{ label: `${"x".repeat(14)}😀`, data: "extra" }],
    });
    const extraAction = cardButtons(card.footer)
      .map((button) => button.action)
      .find((action) => action.type === "postback" && action.data === "extra");

    expect(extraAction?.label).toBe(`${"x".repeat(14)}😀`);
    expect(loneHighSurrogate.test(extraAction?.label ?? "")).toBe(false);
  });

  it("uriAction visibly disables overlong links instead of changing their destination", () => {
    const validUri = `https://e.example/?q=${"u".repeat(979)}`;
    const validAction = uriAction("Open", validUri) as { type: string; uri?: string };
    const overlongAction = uriAction("Open", `${validUri}u`) as {
      type: string;
      label?: string;
      text?: string;
    };

    expect(validUri).toHaveLength(1000);
    expect(validAction).toMatchObject({ type: "uri", uri: validUri });
    expect(overlongAction).toEqual(expectedUnavailableLink);
  });

  it("buttons template payload visibly disables URIs past the 1000-unit cap", () => {
    const template = buildTemplateMessageFromPayload({
      type: "buttons",
      text: "Pick",
      actions: [{ type: "uri", label: "Open", uri: `https://e.example/?q=${"u".repeat(1200)}` }],
    });

    const message = expectDefined(template, "buttons template message");
    if (message.type !== "template" || message.template.type !== "buttons") {
      throw new Error("expected buttons template");
    }
    const buttonsTemplate = message.template;
    const uriTemplateAction = expectDefined(
      buttonsTemplate.actions[0],
      "buttons template uri action",
    );
    expect(uriTemplateAction).toEqual(expectedUnavailableLink);
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

  it("normalizes raw actions at exported flex builder boundaries", () => {
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

    const image = createImageCard("https://e.example/image.jpg", "Image", undefined, {
      action: oversizedUri,
    });
    expect((image.hero as { action?: Action }).action).toEqual(expectedUnavailableLink);

    const card = createActionCard("Title", "Body", [{ label: "Open", action: oversizedPostback }]);
    const button = (card.footer as { contents: Array<{ action: Action }> }).contents[0];
    expect(button?.action).toEqual(expectedUnavailableCallbackAction);

    const validLongLabel = "x".repeat(40);
    const labeledCard = createActionCard("Title", "Body", [
      { label: validLongLabel, action: { type: "message", label: validLongLabel, text: "Open" } },
    ]);
    const labeledButton = (labeledCard.footer as { contents: Array<{ action: Action }> })
      .contents[0];
    expect(labeledButton?.action.label).toBe(validLongLabel);

    const list = createListCard("List", [{ title: "Item", action: oversizedPostback }]);
    const listBody = (list.body as { contents: unknown[] }).contents;
    const listBox = listBody[2] as {
      contents: Array<{ action?: Action }>;
    };
    expect(listBox.contents[0]?.action).toEqual(expectedUnavailableCallbackAction);

    const event = createEventCard({
      title: "Event",
      date: "Today",
      action: oversizedUri,
    });
    expect((event.body as { action?: Action }).action).toEqual(expectedUnavailableLink);
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
      extraActions: [{ label: "Extra", data: overlongData }],
    });
    const actions = cardButtons(card.footer).map((button) => button.action);

    expect(actions).toHaveLength(5);
    for (const action of actions) {
      expect(action).toEqual(expectedUnavailableCallbackAction);
    }
  });

  it("device controls visibly disable overlong opaque callbacks", () => {
    const card = createDeviceControlCard({
      deviceName: "Device",
      controls: [{ label: "On", data: `${"d".repeat(299)}😀` }],
    });
    const action = cardButtons(card.footer)[0]?.action;

    expect(action).toEqual(expectedUnavailableCallbackAction);
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
