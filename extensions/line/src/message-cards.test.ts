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
import { createEventCard } from "./flex-templates/schedule-cards.js";
import { renderLineCard } from "./rich-messages.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineTemplateMessagePayload } from "./types.js";

function renderTemplate(payload: LineTemplateMessagePayload): messagingApi.TemplateMessage {
  const message = buildTemplateMessageFromPayload(payload);
  if (message?.type !== "template") {
    throw new Error(`Expected a LINE template, received ${message?.type ?? "nothing"}`);
  }
  return message;
}

const unavailable = (text: string) => ({ type: "message", label: "Unavailable", text });
const expectedUnavailableCallbackAction = unavailable(
  "Action unavailable: callback data exceeds LINE's limit.",
);
const expectedUnavailableLink = unavailable("Link unavailable: URL exceeds LINE's limit.");
const expectedUnavailableMessageText = unavailable(
  "Action unavailable: message text exceeds LINE's limit.",
);
const postback = (fields: Partial<messagingApi.PostbackAction>) =>
  ({ type: "postback", label: "Open", data: "action=open", ...fields }) satisfies Action;

const loneHighSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const lineFlexCardCommandScenarios = ["info", "image"] as const;
const oversizedPostback: Action = { type: "postback", label: "Open", data: "x".repeat(301) };
const oversizedUri: Action = {
  type: "uri",
  label: "Open",
  uri: `https://e.example/?q=${"x".repeat(1200)}`,
};
const overlongData = `${"d".repeat(299)}😀`;
const picker = (data: string, label = "Pick") =>
  normalizeLineAction({ type: "datetimepicker", label, data, mode: "datetime" });
const templateMessage = (template: messagingApi.Template) =>
  normalizeLineMessage({ type: "template", altText: "Pick", template });
const flexMessage = (contents: messagingApi.FlexContainer) =>
  normalizeLineMessage({ type: "flex", altText: "Controls", contents });
const flexBox = (
  contents: messagingApi.FlexComponent[],
  action?: Action,
): messagingApi.FlexBox => ({
  type: "box",
  layout: "vertical",
  contents,
  ...(action ? { action } : {}),
});
const deviceCard = (controls: Array<{ label: string; action: string }>) =>
  renderLineCard({ type: "device", name: "Device", controls }).contents;

type FlexMessage = Pick<messagingApi.FlexMessage, "altText" | "contents">;
async function runLineFlexCardCommand(args: string): Promise<FlexMessage> {
  const result = await handleLineCardCommand(args);
  const line = result.channelData?.line as { flexMessage: FlexMessage } | undefined;
  return expectDefined(line, "LINE card data").flexMessage;
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

function flexBody(message: messagingApi.Message) {
  if (
    message.type !== "flex" ||
    message.contents.type !== "bubble" ||
    message.contents.body?.type !== "box"
  ) {
    throw new Error("Expected Flex bubble with box body");
  }
  return message.contents.body.contents;
}

describe("LINE message cards", () => {
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
    [{ thumbnailImageUrl: "https://example.com/thumb.jpg", text: "x".repeat(150) }, "x".repeat(60)],
    [{ title: "Title", text: `😀${"\u0301".repeat(59)}` }, `😀${"\u0301".repeat(58)}`],
  ] as const)("bounds carousel text for %j", (column, expected) => {
    const message = renderTemplate({
      type: "carousel",
      columns: [{ ...column, actions: [{ type: "message", label: "OK" }] }],
    });
    expect(message.template).toMatchObject({ columns: [{ text: expected }] });
  });
  it("includes footer when provided", () => {
    const card = createInfoCard("Title", "Body", "Footer text");

    expect(card.footer).toHaveProperty("contents.0.text", "Footer text");
  });

  it("limits device controls to 6", () => {
    const card = deviceCard(
      Array.from({ length: 10 }, (_, i) => ({
        label: `Control ${i}`,
        action: `action=${i}`,
      })),
    );

    expect(card.footer?.contents).toHaveLength(3);
    expect(cardButtons(card.footer).map((button) => button.action)).toEqual(
      Array.from({ length: 6 }, (_, i) => ({
        type: "postback",
        label: `Control ${i}`,
        data: `line.action=action%3D${i}&line.device=device`,
      })),
    );
  });

  it("keeps event-card optional fields together", () => {
    const card = createEventCard({
      title: "Event",
      date: "Date",
      time: "Time",
      location: "Office",
      description: "Details",
    });

    expect(card.size).toBe("mega");
    expect(card.body?.contents).toHaveLength(3);
  });
  // The emoji straddles a naive 20-code-unit slice.
  const labelWithEmoji = "1234567890123456789😀";

  it("messageAction drops a half emoji instead of leaving a lone surrogate", () => {
    const action = messageAction(labelWithEmoji);

    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(expectDefined(action.label, "action label"))).toBe(false);
  });

  it("datetime picker normalization preserves labels and disables overlong callback data", () => {
    const exactData = `${"d".repeat(298)}😀`;
    const action = picker("data", labelWithEmoji);
    const exact = picker(exactData);
    const disabledPicker = picker(overlongData);

    expect(exactData).toHaveLength(300);
    expect(overlongData).toHaveLength(301);
    expect(action.label).toBe(labelWithEmoji);
    expect(loneHighSurrogate.test(expectDefined(action.label, "picker label"))).toBe(false);
    expect(exact).toHaveProperty("data", exactData);
    expect(disabledPicker).toEqual(expectedUnavailableCallbackAction);
  });

  it.each([
    ["message", "/status", { type: "message", text: "/status" }],
    ["postback", "action=status", { type: "postback", data: "action=status" }],
    ["uri", "https://example.test/status", { type: "uri", uri: "https://example.test/status" }],
  ] as const)("/card action preserves 40-character %s labels", async (_kind, data, expected) => {
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
    "/card %s preserves provider-valid Flex alternative text",
    async (kind) => {
      const body = "a".repeat(1200);
      const message = await runLineFlexCardCommand(
        `${kind} "Title" "${body}"${kind === "image" ? " --url https://example.test/image.png" : ""}`,
      );
      expect(message.altText).toBe(`Title: ${body}`);
    },
  );

  it("device control postback labels count grapheme clusters", () => {
    const label = `${"x".repeat(17)}😀`;
    const card = deviceCard([{ label, action: "extra" }]);
    const extraAction = cardButtons(card.footer)
      .map((button) => button.action)
      .find(
        (action) =>
          action.type === "postback" && action.data === "line.action=extra&line.device=device",
      );

    expect(extraAction?.label).toBe(label);
    expect(loneHighSurrogate.test(extraAction?.label ?? "")).toBe(false);
  });

  it("buttons template payload visibly disables overlong postback data", () => {
    const message = renderTemplate({
      type: "buttons",
      text: "Pick",
      actions: [{ type: "postback", label: "Open", data: `action=open&token=${"x".repeat(300)}` }],
    });
    expect(message).toHaveProperty("template.type", "buttons");
    expect(message).toHaveProperty("template.actions.0", expectedUnavailableCallbackAction);
  });

  it("normalizes raw template actions at the outbound message boundary", () => {
    const buttons = templateMessage({
      type: "buttons",
      text: "Pick",
      actions: [oversizedPostback],
      defaultAction: oversizedUri,
    });
    expect(buttons).toMatchObject({ template: { actions: [expectedUnavailableCallbackAction] } });

    expect(buttons).not.toHaveProperty("template.defaultAction");
    const carousel = templateMessage({
      type: "carousel",
      columns: [
        {
          text: "Pick",
          actions: [oversizedPostback],
          defaultAction: { type: "uri", uri: "https://example.com" },
        },
      ],
    });
    expect(carousel).toMatchObject({
      template: { columns: [{ actions: [expectedUnavailableCallbackAction] }] },
    });
    expect(carousel).not.toHaveProperty("template.columns.0.defaultAction");
  });

  it.each([
    ["2026-06-01t09:00", "2026-06-01T10:00", true],
    ["2026-06-01T10:00", "2026-06-01t09:00", false],
    ["2026-06-01T09:00", "2026-06-01t09:00", false],
  ] as const)("compares picker bounds without rewriting %s / %s", (min, max, valid) => {
    const action = normalizeLineAction({
      type: "datetimepicker",
      data: "",
      mode: "datetime",
      min,
      max,
    });
    if (action.type !== "datetimepicker") {
      throw new Error("Expected date picker");
    }
    expect({ min: action.min, max: action.max }).toEqual({
      min: valid ? min : undefined,
      max: valid ? max : undefined,
    });
  });

  it("preserves quick-reply-only controls and removes unusable optional actions", () => {
    const normalized = normalizeLineMessage({
      type: "template",
      altText: "Carousel",
      template: {
        type: "image_carousel",
        columns: [
          { imageUrl: "https://example.com/image.png", action: { type: "uri", uri: "line://app" } },
        ],
      },
      quickReply: {
        items: [
          { action: { type: "camera", label: "Camera" } },
          { action: { type: "cameraRoll", label: "Photos" } },
          { action: { type: "location", label: "Location" } },
          { action: { type: "postback", label: "Run", data: "", text: "Legacy" } },
        ],
      },
    });
    expect(normalized.quickReply?.items).toEqual([
      { type: "action", action: { type: "camera", label: "Camera" } },
      { type: "action", action: { type: "cameraRoll", label: "Photos" } },
      { type: "action", action: { type: "location", label: "Location" } },
      {
        type: "action",
        action: { type: "postback", label: "Run", data: "", displayText: "Legacy" },
      },
    ]);
    if (normalized.type !== "template" || normalized.template.type !== "image_carousel") {
      throw new Error("Expected carousel");
    }
    expect(normalized.template.columns[0]?.action).toEqual({ type: "uri", uri: "line://app" });
    const flex = flexMessage({
      type: "bubble",
      body: flexBox([
        { type: "button", action: { type: "uri", uri: "https://example.com" } },
        {
          type: "text",
          text: "Status",
          action: { type: "richmenuswitch", richMenuAliasId: "menu", data: "" },
        },
      ]),
    });
    expect(flexBody(flex)).toMatchObject([
      { type: "button", action: { type: "message", label: "Unavailable" } },
      { type: "text", text: "Status" },
      { type: "text", text: expect.stringContaining("rich menus") },
    ]);
    expect(flex).not.toHaveProperty("contents.body.contents.1.action");
  });

  it("normalizes every length-constrained raw action field", () => {
    const tooLong = "x".repeat(301);
    for (const action of [
      { type: "message", label: "Open", text: tooLong },
      postback({ inputOption: "openKeyboard", fillInText: tooLong }),
      postback({ text: tooLong }),
    ] satisfies Action[]) {
      expect(normalizeLineAction(action)).toEqual(expectedUnavailableMessageText);
    }
    expect(normalizeLineAction(postback({ displayText: "d".repeat(301) }))).toMatchObject({
      displayText: "d".repeat(300),
    });
    expect(
      normalizeLineAction({
        type: "uri",
        label: "Open",
        uri: "https://e.example",
        altUri: { desktop: `https://e.example/?q=${"x".repeat(1200)}` },
      }),
    ).toEqual({ type: "uri", label: "Open", uri: "https://e.example" });
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
      normalizeLineAction({ type: "clipboard", label: "Copy", clipboardText: "x".repeat(1001) }),
    ).toEqual(unavailable("Action unavailable: clipboard text exceeds LINE's limit."));
  });

  it("normalizes action cards and raw Flex actions at the outbound boundary", () => {
    const card = createActionCard("Title", "Body", [oversizedPostback]);
    expect(card.footer).toHaveProperty("contents.0.action", expectedUnavailableCallbackAction);

    const validLongLabel = "x".repeat(40);
    const labeledCard = createActionCard("Title", "Body", [
      { type: "message", label: validLongLabel, text: "Open" },
    ]);
    expect(labeledCard.footer).toHaveProperty("contents.0.action.label", validLongLabel);

    const normalized = flexMessage({
      type: "bubble",
      hero: { type: "image", url: "https://e.example/image.jpg", action: oversizedUri },
      body: flexBox([{ type: "text", text: "Event", action: oversizedPostback }], oversizedUri),
    });
    expect(normalized).toMatchObject({
      contents: {
        hero: { type: "image", url: "https://e.example/image.jpg" },
      },
    });
    expect(flexBody(normalized)).toMatchObject([
      { type: "text", text: "Event" },
      {
        type: "text",
        text: `${expectedUnavailableLink.text}\n${expectedUnavailableCallbackAction.text}`,
      },
    ]);
    expect(JSON.stringify(normalized)).not.toContain('"action":');
  });

  it.each([
    [{ type: "media_player", title: "Track", source: "d".repeat(301) }, "footer", 4],
    [{ type: "appletv_remote", name: "d".repeat(301) }, "body", 12],
  ] as const)("%j visibly disables overlong opaque callbacks", (input, section, count) => {
    const { contents: card } = renderLineCard(input);
    expect(cardButtons(card[section]).map((button) => button.action)).toEqual(
      Array.from({ length: count }, () => expectedUnavailableCallbackAction),
    );
  });
});
