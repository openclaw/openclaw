import type { messagingApi } from "@line/bot-sdk";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  renderPresentationForDelivery,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
  type MessagePresentation,
  type MessagePresentationAction,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  resolveAskUserQuestionOptionIndices,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasLineCredentials } from "./account-helpers.js";
import { resolveLineAccount } from "./accounts.js";
import { messageAction, postbackAction, truncateLineActionLabel, type Action } from "./actions.js";
import { createActionCard } from "./flex-templates/basic-cards.js";
import { cardBox, cardText, createCardBubble, createCardTitle } from "./flex-templates/common.js";
import { fitsLineFlexBubble } from "./flex-templates/message.js";
import { createAgendaCard, createEventCard } from "./flex-templates/schedule-cards.js";
import type { FlexBox, FlexBubble, FlexButton, FlexComponent } from "./flex-templates/types.js";
import { inferLineTargetChatType } from "./messaging-target.js";
import { buildLineQuestionPostbackData } from "./question-postback.js";
import { lineChannelDataSchema, type LineRichCard } from "./rich-message-schema.js";
import type { LineQuickReplyItem } from "./types.js";

export const lineMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const account = resolveLineAccount({ cfg, accountId: accountId ?? undefined });
    return account.enabled && hasLineCredentials(account)
      ? {
          actions: ["send"],
          capabilities: ["presentation"],
          schema: {
            actions: ["send"],
            properties: { channelData: lineChannelDataSchema },
          },
        }
      : { actions: [], capabilities: [], schema: null };
  },
  prepareSendPayload: ({ payload }) => payload,
};

// LINE's 13-item quick-reply budget is shared by every select in one message.
const LINE_QUICK_REPLY_LIMIT = 13;

export const LINE_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  limits: {
    actions: { maxActions: 4, maxActionsPerRow: 1, maxRows: 4, maxLabelLength: 40 },
    // Native action encoding bounds labels; clipping here also loses plain-text
    // placeholders and option names that overflow the shared quick-reply row.
    selects: { maxOptions: LINE_QUICK_REPLY_LIMIT, maxValueBytes: 300 },
    text: { markdownDialect: "plain" },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

function toLineAction(
  label: string,
  normalized: MessagePresentationAction | undefined,
  questionOptionIndices?: AskUserQuestionOptionIndices,
): Action | undefined {
  if (normalized?.type === "question") {
    if ("intent" in normalized) {
      return undefined;
    }
    // Send the Gateway's canonical index, never an option inferred from its label.
    const optionIndex = resolveAskUserQuestionOptionIndex({
      questionOptionIndices,
      questionId: normalized.questionId,
      optionValue: normalized.optionValue,
    });
    const data =
      optionIndex === undefined
        ? undefined
        : buildLineQuestionPostbackData({ questionId: normalized.questionId, optionIndex });
    if (!data) {
      return undefined;
    }
    return { type: "postback", label, data, displayText: label };
  }
  if (normalized?.type === "command") {
    return { type: "message", label, text: normalized.command };
  }
  if (normalized?.type === "callback") {
    return { type: "postback", label, data: normalized.value, displayText: label };
  }
  if (normalized?.type === "url") {
    return { type: "uri", label, uri: normalized.url };
  }
  if (normalized?.type === "web-app" && normalized.url) {
    return { type: "uri", label, uri: normalized.url };
  }
  return undefined;
}

export function renderLinePresentation(
  payload: ReplyPayload,
  presentation: MessagePresentation,
  to?: string,
  sourcePresentation: MessagePresentation = presentation,
) {
  const hasQuestion = sourcePresentation.blocks.some(
    (block) =>
      block.type === "buttons" &&
      block.buttons.some(
        (button) => resolveMessagePresentationButtonAction(button)?.type === "question",
      ),
  );
  const hasAuthoredPrompt =
    Boolean(sourcePresentation.title?.trim()) ||
    sourcePresentation.blocks.some(
      (block) => (block.type === "text" || block.type === "context") && block.text.trim(),
    );
  // Adaptation may add Actions/Other guidance, which cannot replace the prompt.
  // Declining native rendering preserves the producer's complete text fallback.
  if (hasQuestion && !hasAuthoredPrompt) {
    return null;
  }
  // Group and room postbacks do not carry the sender identity required by
  // question admission. Keep their choices readable through the shared fallback.
  if (inferLineTargetChatType(to ?? "") !== "direct" && hasQuestion) {
    return null;
  }
  const hasCard = presentation.blocks.some(
    (block) => block.type === "buttons" && block.buttons.length > 0,
  );
  const buttons: Action[] = [];
  const quickReplyItems: LineQuickReplyItem[] = [];
  const carriedBlocks: MessagePresentationBlock[] = [];
  const cardBody: string[] = [];
  // Keep omitted controls visible using the shared adapter's `Actions:` wording.
  const omittedControlLabels: string[] = [];
  const questionLabels = new Set<string>();
  const questionOptionIndices = resolveAskUserQuestionOptionIndices(payload);
  for (const block of presentation.blocks) {
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        const normalized = resolveMessagePresentationButtonAction(button);
        // Only plain-text inbound can claim a free-text answer; a postback adds no action.
        if (
          normalized?.type === "question" &&
          "intent" in normalized &&
          normalized.intent === "custom-input"
        ) {
          omittedControlLabels.push(button.label);
          continue;
        }
        const action = toLineAction(button.label, normalized, questionOptionIndices);
        if (!action) {
          return null;
        }
        // Truncation can make distinct options look identical; retain the text fallback.
        if (normalized?.type === "question") {
          if (questionLabels.has(button.label)) {
            return null;
          }
          questionLabels.add(button.label);
        }
        buttons.push(action);
      }
    } else if (block.type === "select") {
      const overflow: typeof block.options = [];
      for (const option of block.options) {
        const action = resolveMessagePresentationOptionAction(option);
        if (!action) {
          return null;
        }
        if (quickReplyItems.length < LINE_QUICK_REPLY_LIMIT) {
          quickReplyItems.push({ label: option.label, action });
        } else {
          overflow.push(option);
        }
      }
      // Keep each prompt beside its own overflow; an empty select would lose its
      // placeholder in the fallback renderer even though its chips still need it.
      if (overflow.length > 0) {
        carriedBlocks.push({ ...block, options: overflow });
      } else if (block.placeholder) {
        carriedBlocks.push({ type: "context", text: block.placeholder });
      }
    } else if (!hasCard) {
      carriedBlocks.push(block);
    } else if (block.type === "text" || block.type === "context") {
      cardBody.push(block.text);
    }
  }
  if (buttons.length === 0 && quickReplyItems.length === 0) {
    return null;
  }
  if (hasCard && omittedControlLabels.length > 0) {
    cardBody.push(`Actions:\n${omittedControlLabels.map((label) => `- ${label}`).join("\n")}`);
  }

  const lineData = isRecord(payload.channelData?.line) ? payload.channelData.line : {};
  const title = presentation.title || "Choose an option";
  // The card's own heading can be generic, but altText is the whole message in
  // the notification and the chat list, so it carries the words being asked.
  const altText = presentation.title || cardBody[0] || title;
  const flexMessage = hasCard
    ? {
        altText,
        contents: createActionCard(title, cardBody.join("\n") || "Choose an option.", buttons),
      }
    : undefined;
  if (flexMessage && !fitsLineFlexBubble(flexMessage.contents)) {
    return null;
  }
  const text = renderMessagePresentationFallbackText({
    text: payload.text,
    presentation: { title: hasCard ? undefined : presentation.title, blocks: carriedBlocks },
  });
  return {
    ...payload,
    ...(text ? { text } : {}),
    channelData: {
      ...payload.channelData,
      line: {
        ...lineData,
        ...(flexMessage ? { flexMessage } : {}),
        quickReplyItems,
      },
    },
  };
}

/**
 * Resolve a reply's portable presentation into LINE-native controls.
 *
 * Core runs the presentation renderer inside the outbound send pipeline only, so
 * replies the plugin delivers itself reach delivery with the controls still
 * portable. Preparing them here keeps both LINE delivery paths on one rendering.
 */
export async function prepareLineReplyPayload(
  payload: ReplyPayload,
  to?: string,
): Promise<ReplyPayload> {
  if (!normalizeMessagePresentation(payload.presentation)) {
    return payload;
  }
  const usesFallbackText =
    payload.presentationTextMode === "fallback" && Boolean(payload.text?.trim());
  return renderPresentationForDelivery(
    {
      presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
      renderPresentation: (adapted, sourcePresentation) => {
        const rendered = renderLinePresentation(
          adapted,
          adapted.presentation,
          to,
          sourcePresentation,
        );
        // Quick replies have no Flex body to replace the author's fallback prose.
        return rendered && usesFallbackText && rendered.channelData.line.flexMessage === undefined
          ? { ...rendered, text: payload.text }
          : rendered;
      },
    },
    { ...payload, presentationTextMode: usesFallbackText ? "fallback" : undefined },
  );
}

const toSlug = (value: string): string =>
  normalizeLowercaseStringOrEmpty(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "device";

const lineActionData = (action: string, device: string): string =>
  `line.action=${encodeURIComponent(action)}&line.device=${encodeURIComponent(device)}`;

function createControlButton(
  label: string,
  data: string,
  style: "primary" | "secondary" = "secondary",
): FlexButton {
  return { type: "button", action: postbackAction(label, data), style, height: "sm", flex: 1 };
}

export function renderLineCard(card: LineRichCard): { altText: string; contents: FlexBubble } {
  if (card.type === "media_player") {
    const device = toSlug(card.source || card.title);
    const isPlaying = card.status ? card.status === "playing" : undefined;
    const trackInfo: FlexComponent[] = [createCardTitle(card.title)];
    if (card.artist) {
      trackInfo.push(
        cardText(card.artist, { size: "md", color: "#666666", wrap: true, margin: "sm" }),
      );
    }
    const statusItems: FlexComponent[] = [];
    if (isPlaying !== undefined) {
      statusItems.push(
        cardBox(
          "horizontal",
          [
            cardBox("vertical", [], {
              width: "8px",
              height: "8px",
              backgroundColor: isPlaying ? "#06C755" : "#CCCCCC",
              cornerRadius: "4px",
            }),
            cardText(isPlaying ? "Now Playing" : "Paused", {
              size: "xs",
              color: isPlaying ? "#06C755" : "#888888",
              weight: "bold",
              margin: "sm",
            }),
          ],
          { alignItems: "center" },
        ),
      );
    }
    if (card.source) {
      statusItems.push(
        cardText(card.source, {
          size: "xs",
          color: "#AAAAAA",
          margin: statusItems.length > 0 ? "lg" : undefined,
        }),
      );
    }
    const bodyContents: FlexComponent[] = [cardBox("vertical", trackInfo)];
    if (statusItems.length > 0) {
      bodyContents.push(cardBox("horizontal", statusItems, { margin: "lg", alignItems: "center" }));
    }
    const bubble = createCardBubble(bodyContents);
    if (card.imageUrl) {
      bubble.hero = {
        type: "image",
        url: card.imageUrl,
        size: "full",
        aspectRatio: "1:1",
        aspectMode: "cover",
      };
    }
    const controlButtons: FlexComponent[] = [];
    for (const [key, label, style] of [
      ["previous", "⏮", "secondary"],
      ["play", "▶", isPlaying ? "secondary" : "primary"],
      ["pause", "⏸", isPlaying ? "primary" : "secondary"],
      ["next", "⏭", "secondary"],
    ] as const) {
      const button = createControlButton(label, lineActionData(key, device), style);
      if (key !== "previous") {
        button.margin = "md";
      }
      controlButtons.push(button);
    }
    bubble.footer = cardBox("vertical", [cardBox("horizontal", controlButtons)], {
      paddingAll: "lg",
      backgroundColor: "#FAFAFA",
    });
    return {
      altText: `🎵 ${card.title}${card.artist ? ` - ${card.artist}` : ""}`,
      contents: bubble,
    };
  }
  if (card.type === "event") {
    return {
      altText: `📅 ${card.title} - ${card.date}${card.time ? ` ${card.time}` : ""}`,
      contents: createEventCard(card),
    };
  }
  if (card.type === "agenda") {
    return {
      altText: `📋 ${card.title} (${card.events.length} events)`,
      contents: createAgendaCard(card),
    };
  }
  const device = toSlug(card.type === "device" ? card.name : card.name || "apple_tv");
  if (card.type === "device") {
    const headerContents: FlexComponent[] = [
      cardBox(
        "horizontal",
        [
          cardBox("vertical", [], {
            width: "10px",
            height: "10px",
            backgroundColor: "#06C755",
            cornerRadius: "5px",
          }),
          { ...createCardTitle(card.name), flex: 1, margin: "md" },
        ],
        { alignItems: "center" },
      ),
    ];
    if (card.deviceType) {
      headerContents.push(
        cardText(card.deviceType, { size: "sm", color: "#888888", margin: "sm" }),
      );
    }
    if (card.status) {
      headerContents.push(
        cardBox("vertical", [cardText(card.status, { size: "sm", color: "#444444", wrap: true })], {
          margin: "lg",
          paddingAll: "md",
          backgroundColor: "#F8F9FA",
          cornerRadius: "md",
        }),
      );
    }
    const bubble = createCardBubble(headerContents);
    const controls = card.controls ?? [];
    if (controls.length > 0) {
      const rows: FlexComponent[] = [];
      const limitedControls = controls.slice(0, 6);
      for (let i = 0; i < limitedControls.length; i += 2) {
        const rowButtons: FlexComponent[] = [];
        for (const [offset, ctrl] of limitedControls.slice(i, i + 2).entries()) {
          rowButtons.push({
            ...createControlButton(
              truncateLineActionLabel(ctrl.label, 18),
              lineActionData(ctrl.action, device),
            ),
            margin: offset > 0 ? "md" : undefined,
          });
        }
        if (rowButtons.length === 1) {
          rowButtons.push({ type: "filler" });
        }
        rows.push(cardBox("horizontal", rowButtons, { margin: i > 0 ? "md" : undefined }));
      }
      bubble.footer = cardBox("vertical", rows, { paddingAll: "lg", backgroundColor: "#FAFAFA" });
    }
    return {
      altText: `📱 ${card.name}${card.status ? `: ${card.status}` : ""}`,
      contents: bubble,
    };
  }
  const headerContents: FlexComponent[] = [createCardTitle(card.name || "Apple TV")];
  if (card.status) {
    headerContents.push(
      cardText(card.status, { size: "sm", color: "#666666", wrap: true, margin: "sm" }),
    );
  }
  const rows: [FlexBox["margin"], Array<[label: string, action: string] | null>][] = [
    [undefined, [null, ["↑", "up"], null]],
    [
      "md",
      [
        ["←", "left"],
        ["OK", "select"],
        ["→", "right"],
      ],
    ],
    ["md", [null, ["↓", "down"], null]],
    [
      "lg",
      [
        ["Menu", "menu"],
        ["Home", "home"],
      ],
    ],
    [
      "md",
      [
        ["Play", "play"],
        ["Pause", "pause"],
      ],
    ],
    [
      "md",
      [
        ["Vol +", "volume_up"],
        ["Mute", "mute"],
        ["Vol -", "volume_down"],
      ],
    ],
  ];
  const controlRows = rows.map(([margin, buttons]) =>
    cardBox(
      "horizontal",
      buttons.map((button) =>
        button
          ? createControlButton(
              button[0],
              lineActionData(button[1], device),
              button[1] === "select" ? "primary" : "secondary",
            )
          : { type: "filler" },
      ),
      margin ? { margin } : {},
    ),
  );
  return {
    altText: `📺 ${card.name || "Apple TV"} Remote`,
    contents: createCardBubble([
      cardBox("vertical", headerContents),
      { type: "separator", margin: "lg", color: "#EEEEEE" },
      ...controlRows,
    ]),
  };
}

export function createLineQuickReply(items: LineQuickReplyItem[]): messagingApi.QuickReply {
  return {
    items: items.slice(0, LINE_QUICK_REPLY_LIMIT).map((item) => ({
      type: "action",
      action:
        item.action.type === "command"
          ? messageAction(item.label, item.action.command)
          : postbackAction(item.label, item.action.value, item.label),
    })),
  };
}
