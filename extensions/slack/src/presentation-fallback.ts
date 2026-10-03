// Slack-specific structured-data fallback keeps raw chart/table values literal in mrkdwn.
import {
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  type MessagePresentation,
  type MessagePresentationBlock,
  type MessagePresentationChartBlock,
  type MessagePresentationTableBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

const SLACK_UNCOPYABLE_COMMAND_WARNING = "not copyable: contains backtick";

// Slack inline code cannot escape its ASCII backtick delimiter. Make the changed
// byte explicit so the fallback cannot look like a copyable version of the command.
function resolveSlackCommandFallback(command: string): {
  command: string;
  warning?: string;
} {
  if (!command.includes("`")) {
    return { command };
  }
  return {
    command: command.replaceAll("`", "[backtick]"),
    warning: SLACK_UNCOPYABLE_COMMAND_WARNING,
  };
}

function escapeSlackPresentationFallbackBlock(
  block: MessagePresentationBlock,
): MessagePresentationBlock {
  if (block.type === "chart") {
    return { type: "text", text: renderSlackMessagePresentationChartFallbackText(block) };
  }
  if (block.type === "table") {
    return { type: "text", text: renderSlackMessagePresentationTableFallbackText(block) };
  }
  if (block.type === "buttons") {
    return {
      ...block,
      buttons: block.buttons.map((button) => {
        const commandFallback =
          button.action?.type === "command"
            ? resolveSlackCommandFallback(button.action.command)
            : undefined;
        const label = commandFallback?.warning
          ? `${button.label} [${commandFallback.warning}]`
          : button.label;
        return {
          ...button,
          label: escapeSlackMrkdwn(label),
          ...(button.value ? { value: escapeSlackMrkdwn(button.value) } : {}),
          ...(button.url ? { url: escapeSlackMrkdwn(button.url) } : {}),
          ...(button.webApp ? { webApp: { url: escapeSlackMrkdwn(button.webApp.url) } } : {}),
          ...(button.web_app ? { web_app: { url: escapeSlackMrkdwn(button.web_app.url) } } : {}),
          ...(button.action?.type === "command" && commandFallback
            ? {
                action: {
                  ...button.action,
                  command: commandFallback.command,
                },
              }
            : {}),
        };
      }),
    };
  }
  if (block.type === "select") {
    return {
      ...block,
      ...(block.placeholder ? { placeholder: escapeSlackMrkdwn(block.placeholder) } : {}),
      options: block.options.map((option) => ({
        ...option,
        label: escapeSlackMrkdwn(option.label),
      })),
    };
  }
  return block;
}

export function renderSlackMessagePresentationChartFallbackText(
  block: MessagePresentationChartBlock,
): string {
  return escapeSlackMrkdwn(renderMessagePresentationChartFallbackText(block));
}

export function renderSlackMessagePresentationTableFallbackText(
  block: MessagePresentationTableBlock,
): string {
  return escapeSlackMrkdwn(renderMessagePresentationTableFallbackText(block));
}

export function renderSlackMessagePresentationFallbackText(params: {
  presentation?: MessagePresentation;
  emptyFallback?: string | null;
  text?: string | null;
}): string {
  if (!params.presentation) {
    return renderMessagePresentationFallbackText(params);
  }
  const presentation: MessagePresentation = {
    ...params.presentation,
    ...(params.presentation.title ? { title: escapeSlackMrkdwn(params.presentation.title) } : {}),
    blocks: params.presentation.blocks.map(escapeSlackPresentationFallbackBlock),
  };
  return renderMessagePresentationFallbackText({ ...params, presentation });
}
