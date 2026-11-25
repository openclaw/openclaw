import {
  agentControlText,
  legacyInteractiveReplyToPresentation,
  resolveMessagePresentationActionValue,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  LegacyInteractiveReply,
  MessagePresentation,
  MessagePresentationButton,
  MessagePresentationSelectBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import { buildDiscordApprovalCustomId } from "./approval-custom-id.js";
import {
  buildDiscordActivityCustomId,
  buildDiscordAgentButtonCustomId,
  buildDiscordAgentSelectCustomId,
  isValidDiscordActivityWidgetId,
} from "./component-custom-id.js";
import type {
  DiscordComponentButtonSpec,
  DiscordComponentMessageSpec,
} from "./components.types.js";
import { buildDiscordQuestionCustomId } from "./question-custom-id.js";

const DISCORD_INTERACTIVE_BUTTON_ROW_SIZE = 5;

/**
 * Agent controls are stateless only when every one fits its id; otherwise all of them use the
 * registry, so one tap consumes them together.
 */
type AgentControlIds = { stateless: boolean; index: number; overflow: boolean };

function buildDiscordButtonComponent(
  button: MessagePresentationButton,
  options: DiscordPresentationBuildOptions,
  agentIds: AgentControlIds,
): DiscordComponentButtonSpec | undefined {
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return undefined;
  }
  const component: DiscordComponentButtonSpec = {
    label: button.label,
    style: button.style ?? "secondary",
    ...(button.disabled === true ? { disabled: true } : {}),
  };
  if (action.type === "approval") {
    const internalCustomId = buildDiscordApprovalCustomId(action);
    return internalCustomId ? { ...component, internalCustomId } : undefined;
  }
  if (action.type === "question") {
    if ("intent" in action) {
      return undefined;
    }
    const optionIndex = resolveAskUserQuestionOptionIndex({
      questionOptionIndices: options.questionOptionIndices,
      questionId: action.questionId,
      optionValue: action.optionValue,
    });
    if (optionIndex === undefined) {
      return undefined;
    }
    const internalCustomId = buildDiscordQuestionCustomId({
      questionId: action.questionId,
      optionIndex,
    });
    return internalCustomId ? { ...component, internalCustomId } : undefined;
  }
  if (
    action.type === "web-app" &&
    action.widgetId &&
    isValidDiscordActivityWidgetId(action.widgetId)
  ) {
    component.internalCustomId = buildDiscordActivityCustomId(action.widgetId);
  } else if (action.type === "url" || action.type === "web-app") {
    if (action.type === "web-app" && !action.url) {
      return undefined;
    }
    component.style = "link";
    component.url = action.url;
  } else if (action.type === "callback" && agentControlText(action.value)) {
    const internalCustomId = agentIds.stateless
      ? buildDiscordAgentButtonCustomId(agentIds.index++, action.value, button.reusable === true)
      : undefined;
    if (internalCustomId) {
      return { ...component, internalCustomId };
    }
    agentIds.overflow ||= agentIds.stateless;
    component.callbackData = action.value;
  } else {
    component.callbackData = action.type === "command" ? action.command : action.value;
    if (button.action?.type === "command" || button.action?.type === "callback") {
      component.callbackDataKind = button.action.type;
    }
  }
  if (button.reusable === true) {
    component.reusable = true;
  }
  return component;
}

function appendDiscordSelectBlock(
  blocks: NonNullable<DiscordComponentMessageSpec["blocks"]>,
  block: MessagePresentationSelectBlock,
  agentIds: AgentControlIds,
): void {
  const options: Array<{ label: string; value: string }> = [];
  let callbackDataKind: "command" | "callback" | undefined;
  for (const option of block.options) {
    const value = resolveMessagePresentationActionValue(
      resolveMessagePresentationOptionAction(option),
    );
    if (!value) {
      continue;
    }
    const kind = option.action?.type;
    if (
      (kind !== undefined && kind !== "command" && kind !== "callback") ||
      (options.length > 0 && callbackDataKind !== kind)
    ) {
      return;
    }
    callbackDataKind = kind;
    options.push({ label: option.label, value });
  }
  if (options.length === 0) {
    return;
  }
  const agentOwned =
    agentIds.stateless &&
    callbackDataKind !== "command" &&
    options.every((option) => agentControlText(option.value));
  blocks.push({
    type: "actions",
    select: {
      type: "string",
      placeholder: block.placeholder,
      options,
      ...(agentOwned
        ? { internalCustomId: buildDiscordAgentSelectCustomId(agentIds.index++) }
        : { callbackDataKind }),
    },
  });
}

/**
 * @deprecated Use buildDiscordPresentationComponents with MessagePresentation.
 */
export function buildDiscordInteractiveComponents(
  interactive?: LegacyInteractiveReply,
  options: DiscordPresentationBuildOptions = {},
): DiscordComponentMessageSpec | undefined {
  return buildDiscordPresentationComponents(
    interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined,
    options,
  );
}

export type DiscordPresentationBuildOptions = {
  questionOptionIndices?: AskUserQuestionOptionIndices;
};

export function buildDiscordPresentationComponents(
  presentation?: MessagePresentation,
  options: DiscordPresentationBuildOptions = {},
): DiscordComponentMessageSpec | undefined {
  if (!presentation) {
    return undefined;
  }
  const agentIds: AgentControlIds = { stateless: true, index: 0, overflow: false };
  const blocks = buildDiscordPresentationBlocks(presentation, options, agentIds);
  const registryBlocks = agentIds.overflow
    ? buildDiscordPresentationBlocks(presentation, options, {
        stateless: false,
        index: 0,
        overflow: false,
      })
    : blocks;
  return registryBlocks.length ? { blocks: registryBlocks } : undefined;
}

function buildDiscordPresentationBlocks(
  presentation: MessagePresentation,
  options: DiscordPresentationBuildOptions,
  agentIds: AgentControlIds,
): NonNullable<DiscordComponentMessageSpec["blocks"]> {
  const blocks: NonNullable<DiscordComponentMessageSpec["blocks"]> = [];
  if (presentation.title) {
    blocks.push({ type: "text", text: presentation.title });
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      const text = block.text;
      if (text) {
        blocks.push({
          type: "text",
          text: block.type === "context" ? `-# ${text}` : text,
        });
      }
      continue;
    }
    if (block.type === "divider") {
      blocks.push({ type: "separator" });
      continue;
    }
    if (block.type === "buttons") {
      const components = block.buttons.flatMap((button) => {
        const component = buildDiscordButtonComponent(button, options, agentIds);
        return component ? [component] : [];
      });
      for (let index = 0; index < components.length; index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE) {
        blocks.push({
          type: "actions",
          buttons: components.slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE),
        });
      }
      continue;
    }
    if (block.type === "select") {
      appendDiscordSelectBlock(blocks, block, agentIds);
    }
  }
  return blocks;
}
