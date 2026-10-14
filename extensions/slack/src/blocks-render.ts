import type { ActionsBlock } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  legacyInteractiveReplyToPresentation,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  LegacyInteractiveReply,
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationButtonsBlock,
  MessagePresentationSelectBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { encodeSlackApprovalAction } from "./approval-actions.js";
import {
  buildSlackDataTableBlock,
  countSlackDataTableBlocksCellCharacters,
  countSlackDataTableCellCharacters,
  SLACK_DATA_TABLE_AGGREGATE_CELL_CHARACTERS_MAX,
} from "./data-table.js";
import {
  buildSlackDataVisualizationBlock,
  hasSlackDataVisualizationBlock,
  SLACK_DATA_VISUALIZATION_BLOCKS_MAX,
} from "./data-visualization.js";
import { chunkSlackMrkdwnText } from "./format.js";
import { renderSlackMessagePresentationChartFallbackText } from "./presentation-fallback.js";
import {
  SLACK_ACTION_BLOCK_ELEMENTS_MAX,
  SLACK_ACTION_LABEL_MAX,
  SLACK_BUTTON_VALUE_MAX,
  SLACK_HEADER_TEXT_MAX,
  SLACK_OPTION_VALUE_MAX,
  SLACK_SECTION_TEXT_MAX,
  SLACK_STATIC_SELECT_OPTIONS_MAX,
} from "./presentation.js";
import { encodeSlackQuestionAction } from "./question-actions.js";
import { SLACK_BUTTON_ACTION_IDS, SLACK_SELECT_ACTION_IDS } from "./reply-action-ids.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_BUTTON_URL_MAX = 3000;

export type SlackBlock = Block | KnownBlock;

function buildSlackPlainText(text: string, maxLength: number) {
  return { type: "plain_text" as const, text: truncateSlackText(text, maxLength), emoji: true };
}

export type SlackBlockRenderOptions = {
  buttonIndexOffset?: number;
  dataTableCellCharacterCountOffset?: number;
  dataVisualizationCountOffset?: number;
  questionOptionIndices?: AskUserQuestionOptionIndices;
  selectIndexOffset?: number;
};

function resolveSlackButtonStyle(
  style: "primary" | "secondary" | "success" | "danger" | undefined,
) {
  if (style === "primary" || style === "danger") {
    return style;
  }
  if (style === "success") {
    return "primary";
  }
  return undefined;
}

type SlackActionTarget =
  | { kind: "approval"; value: string }
  | { kind: "callback"; value: string }
  | { kind: "link"; url: string }
  | { kind: "question"; value: string }
  | { kind: "reply"; value: string };

function resolveSlackActionTarget(
  action: MessagePresentationAction | undefined,
  questionOptionIndices?: AskUserQuestionOptionIndices,
): SlackActionTarget | undefined {
  if (!action) {
    return undefined;
  }
  if (action.type === "approval") {
    return { kind: "approval", value: encodeSlackApprovalAction(action) };
  }
  if (action.type === "question") {
    if ("intent" in action) {
      return undefined;
    }
    const optionIndex = resolveAskUserQuestionOptionIndex({
      questionOptionIndices,
      questionId: action.questionId,
      optionValue: action.optionValue,
    });
    const value =
      optionIndex === undefined
        ? undefined
        : encodeSlackQuestionAction({ questionId: action.questionId, optionIndex });
    return value ? { kind: "question", value } : undefined;
  }
  if (action.type === "url" || action.type === "web-app") {
    const url = normalizeOptionalString(action.url);
    return url ? { kind: "link", url } : undefined;
  }
  if (action.type === "callback") {
    const value = normalizeOptionalString(action.value);
    return value ? { kind: "callback", value } : undefined;
  }
  const command = normalizeOptionalString(action.command);
  // Command-backed approvals are a shipped legacy input with no trustworthy
  // owner field. Keep them on the kind-specific compatibility resolver.
  return command && parseExecApprovalCommandText(command)
    ? { kind: "reply", value: command }
    : undefined;
}

function resolveSlackButtonTarget(
  button: MessagePresentationButtonsBlock["buttons"][number],
  questionOptionIndices?: AskUserQuestionOptionIndices,
): SlackActionTarget | undefined {
  if (button.action !== undefined) {
    const action = resolveMessagePresentationButtonAction(button);
    return action ? resolveSlackActionTarget(action, questionOptionIndices) : undefined;
  }

  // Legacy buttons could carry both a URL and callback fallback. Preserve the
  // callback when Slack cannot accept the URL; typed actions stay authoritative.
  const legacyUrl = normalizeOptionalString(
    button.url ?? button.webApp?.url ?? button.web_app?.url,
  );
  if (legacyUrl && legacyUrl.length <= SLACK_BUTTON_URL_MAX) {
    return { kind: "link", url: legacyUrl };
  }
  const legacyValue = normalizeOptionalString(button.value);
  if (legacyValue) {
    return { kind: "reply", value: legacyValue };
  }
  return legacyUrl ? { kind: "link", url: legacyUrl } : undefined;
}

function isSlackTextFallbackButton(
  button: MessagePresentationButtonsBlock["buttons"][number],
): boolean {
  // ask_user already names the free-text path in visible copy. Omitting only
  // this action keeps declared choices native without a composer hook.
  const action = resolveMessagePresentationButtonAction(button);
  return action?.type === "question" && "intent" in action && action.intent === "custom-input";
}

function resolveSlackOptionTarget(
  option: MessagePresentationSelectBlock["options"][number],
): Exclude<SlackActionTarget, { kind: "link" } | { kind: "question" }> | undefined {
  if (option.action !== undefined) {
    const action = resolveMessagePresentationOptionAction(option);
    const target = action ? resolveSlackActionTarget(action) : undefined;
    return target?.kind === "link" || target?.kind === "question" ? undefined : target;
  }
  const value = normalizeOptionalString(option.value);
  return value ? { kind: "reply", value } : undefined;
}

function readSlackOpenClawBlockIndex(blockId: string, prefix: string): number | undefined {
  if (!blockId.startsWith(prefix)) {
    return undefined;
  }
  const value = Number.parseInt(blockId.slice(prefix.length), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Resolve existing Block Kit indexes and native-data budgets before appending portable blocks. */
export function resolveSlackBlockOffsets(
  blocks?: readonly SlackBlock[],
  mode: "all" | "controls" = "all",
): SlackBlockRenderOptions {
  let buttonIndexOffset = 0;
  const dataTableCellCharacterCountOffset =
    mode === "all"
      ? (countSlackDataTableBlocksCellCharacters(blocks) ??
        SLACK_DATA_TABLE_AGGREGATE_CELL_CHARACTERS_MAX + 1)
      : 0;
  let dataVisualizationCountOffset = 0;
  let selectIndexOffset = 0;
  for (const block of blocks ?? []) {
    if (mode === "all" && hasSlackDataVisualizationBlock([block])) {
      dataVisualizationCountOffset += 1;
    }
    const blockId = block.block_id;
    if (typeof blockId !== "string" || !blockId) {
      continue;
    }
    buttonIndexOffset = Math.max(
      buttonIndexOffset,
      readSlackOpenClawBlockIndex(blockId, "openclaw_reply_buttons_") ?? 0,
    );
    selectIndexOffset = Math.max(
      selectIndexOffset,
      readSlackOpenClawBlockIndex(blockId, "openclaw_reply_select_") ?? 0,
    );
  }
  return {
    buttonIndexOffset,
    dataTableCellCharacterCountOffset,
    dataVisualizationCountOffset,
    selectIndexOffset,
  };
}

/**
 * @deprecated Use buildSlackPresentationBlocks with MessagePresentation.
 */
export function buildSlackInteractiveBlocks(
  interactive?: LegacyInteractiveReply,
  options: SlackBlockRenderOptions = {},
): SlackBlock[] {
  return buildSlackPresentationBlocks(
    interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined,
    options,
  );
}

export function buildSlackPresentationBlocks(
  presentation?: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): SlackBlock[] {
  return compileSlackPresentationBlocks(presentation, options, false) ?? [];
}

/** Return native blocks only when every portable control and data block fits. */
export function buildSlackPresentationBlocksIfComplete(
  presentation: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): SlackBlock[] | undefined {
  return compileSlackPresentationBlocks(presentation, options, true);
}

function compileSlackPresentationBlocks(
  presentation: MessagePresentation | undefined,
  options: SlackBlockRenderOptions,
  requireComplete: boolean,
): SlackBlock[] | undefined {
  if (!presentation) {
    return [];
  }
  if (
    requireComplete &&
    presentation.title &&
    presentation.title.trim().length > SLACK_HEADER_TEXT_MAX
  ) {
    return undefined;
  }
  const tables = buildSlackPresentationTables(presentation, options);
  if (requireComplete && !tables) {
    return undefined;
  }
  const blocks: SlackBlock[] = [];
  if (presentation.title) {
    blocks.push({
      type: "header",
      text: buildSlackPlainText(presentation.title, SLACK_HEADER_TEXT_MAX),
    });
  }
  const controlIndices = {
    buttons: options.buttonIndexOffset ?? 0,
    select: options.selectIndexOffset ?? 0,
  };
  let tableIndex = 0;
  let dataVisualizationCount = options.dataVisualizationCountOffset ?? 0;
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      const text = block.text.trim();
      if (!text) {
        continue;
      }
      for (const chunk of chunkSlackMrkdwnText(text, SLACK_SECTION_TEXT_MAX)) {
        blocks.push(
          block.type === "context"
            ? { type: "context", elements: [{ type: "mrkdwn", text: chunk, verbatim: true }] }
            : { type: "section", text: { type: "mrkdwn", text: chunk } },
        );
      }
      continue;
    }
    if (block.type === "divider") {
      blocks.push({ type: "divider" });
      continue;
    }
    if (block.type === "buttons" || block.type === "select") {
      const index = controlIndices[block.type] + 1;
      const elements =
        block.type === "buttons"
          ? buildSlackPresentationButtonElements(
              block,
              index,
              options.questionOptionIndices,
              requireComplete,
            )
          : buildSlackPresentationSelectElements(block, index, requireComplete);
      if (!elements) {
        return undefined;
      }
      if (elements.length > 0) {
        controlIndices[block.type] = index;
        blocks.push({
          type: "actions",
          block_id: `openclaw_reply_${block.type}_${index}`,
          elements,
        });
      }
      continue;
    }
    if (block.type === "chart") {
      const rendered =
        dataVisualizationCount < SLACK_DATA_VISUALIZATION_BLOCKS_MAX
          ? buildSlackDataVisualizationBlock(block)
          : undefined;
      if (rendered) {
        dataVisualizationCount += 1;
        blocks.push(rendered);
      } else if (requireComplete) {
        return undefined;
      } else {
        const fallback = renderSlackMessagePresentationChartFallbackText(block);
        blocks.push(
          ...chunkTextForOutbound(fallback, SLACK_SECTION_TEXT_MAX).map((text): SlackBlock => ({
            type: "context",
            elements: [{ type: "mrkdwn", text, verbatim: true }],
          })),
        );
      }
      continue;
    }
    if (block.type === "table") {
      if (tables) {
        blocks.push(tables[tableIndex++]!);
      }
    }
  }
  return blocks;
}

function buildSlackPresentationButtonElements(
  block: MessagePresentationButtonsBlock,
  buttonIndex: number,
  questionOptionIndices: AskUserQuestionOptionIndices | undefined,
  requireComplete: boolean,
): ActionsBlock["elements"] | undefined {
  let complete = true;
  const elements = block.buttons.flatMap((button, choiceIndex) => {
    const target = resolveSlackButtonTarget(button, questionOptionIndices);
    if (
      !target ||
      (target.kind === "link"
        ? target.url.length > SLACK_BUTTON_URL_MAX
        : target.value.length > SLACK_BUTTON_VALUE_MAX)
    ) {
      if (requireComplete && !isSlackTextFallbackButton(button)) {
        complete = false;
      }
      return [];
    }
    if (button.label.length > SLACK_ACTION_LABEL_MAX) {
      complete = false;
    }
    const style = resolveSlackButtonStyle(button.style);
    return [
      {
        type: "button" as const,
        // Slack emits block_actions even for URL buttons; link-only actions must be ignored.
        action_id: `${SLACK_BUTTON_ACTION_IDS[target.kind]}:${buttonIndex}:${choiceIndex + 1}`,
        text: buildSlackPlainText(button.label, SLACK_ACTION_LABEL_MAX),
        ...(target.kind === "link" ? { url: target.url } : { value: target.value }),
        ...(style ? { style } : {}),
      },
    ];
  });
  if (requireComplete && (!complete || elements.length > SLACK_ACTION_BLOCK_ELEMENTS_MAX)) {
    return undefined;
  }
  return elements.slice(0, SLACK_ACTION_BLOCK_ELEMENTS_MAX);
}

/** Admit tables together: one invalid or over-budget table keeps every table on the text path. */
function buildSlackPresentationTables(
  presentation: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): SlackBlock[] | undefined {
  const tables: SlackBlock[] = [];
  let cellCharacterCount = options.dataTableCellCharacterCountOffset ?? 0;
  for (const block of presentation.blocks) {
    if (block.type !== "table") {
      continue;
    }
    const table = buildSlackDataTableBlock(block, {
      cellCharacterCountOffset: cellCharacterCount,
    });
    if (!table) {
      return undefined;
    }
    cellCharacterCount += countSlackDataTableCellCharacters(table);
    tables.push(table);
  }
  return tables;
}

function buildSlackPresentationSelectElements(
  block: MessagePresentationSelectBlock,
  selectIndex: number,
  requireComplete: boolean,
): ActionsBlock["elements"] | undefined {
  const placeholder = normalizeOptionalString(block.placeholder) ?? "Choose an option";
  const candidates = block.options.map((option) => {
    const target = resolveSlackOptionTarget(option);
    return target ? { label: option.label, ...target } : undefined;
  });
  if (
    requireComplete &&
    (placeholder.length > SLACK_ACTION_LABEL_MAX ||
      block.options.length > SLACK_STATIC_SELECT_OPTIONS_MAX ||
      (block.placeholder && block.placeholder.length > SLACK_ACTION_LABEL_MAX) ||
      !candidates.every(
        (option) =>
          option &&
          option.label.length <= SLACK_ACTION_LABEL_MAX &&
          option.value.length <= SLACK_OPTION_VALUE_MAX,
      ) ||
      new Set(candidates.map((option) => option?.kind)).size !== 1)
  ) {
    return undefined;
  }
  const options = candidates
    .flatMap((option) => (option && option.value.length <= SLACK_OPTION_VALUE_MAX ? [option] : []))
    .slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
  const optionKinds = new Set(options.map((option) => option.kind));
  return options.length > 0 && optionKinds.size === 1
    ? [
        {
          type: "static_select",
          action_id: `${SLACK_SELECT_ACTION_IDS[options[0]!.kind]}:${selectIndex}`,
          placeholder: buildSlackPlainText(placeholder, SLACK_ACTION_LABEL_MAX),
          options: options.map((option) => ({
            text: buildSlackPlainText(option.label, SLACK_ACTION_LABEL_MAX),
            value: option.value,
          })),
        },
      ]
    : [];
}
