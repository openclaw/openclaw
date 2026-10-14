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

function escapeSlackPresentationChartBlock(
  block: MessagePresentationChartBlock,
): MessagePresentationChartBlock {
  const escaped = { ...block, title: escapeSlackMrkdwn(block.title) };
  if (escaped.chartType === "pie") {
    escaped.segments = escaped.segments.map((segment) => ({
      ...segment,
      label: escapeSlackMrkdwn(segment.label),
    }));
  } else {
    escaped.categories = escaped.categories.map(escapeSlackMrkdwn);
    escaped.series = escaped.series.map((series) => ({
      ...series,
      name: escapeSlackMrkdwn(series.name),
    }));
    if (escaped.xLabel) {
      escaped.xLabel = escapeSlackMrkdwn(escaped.xLabel);
    }
    if (escaped.yLabel) {
      escaped.yLabel = escapeSlackMrkdwn(escaped.yLabel);
    }
  }
  return escaped;
}

function escapeSlackPresentationTableBlock(
  block: MessagePresentationTableBlock,
): MessagePresentationTableBlock {
  return {
    ...block,
    caption: escapeSlackMrkdwn(block.caption),
    headers: block.headers.map(escapeSlackMrkdwn),
    rows: block.rows.map((row) =>
      row.map((cell) => (typeof cell === "string" ? escapeSlackMrkdwn(cell) : cell)),
    ),
  };
}

function escapeSlackPresentationFallbackBlock(
  block: MessagePresentationBlock,
): MessagePresentationBlock {
  if (block.type === "chart") {
    return escapeSlackPresentationChartBlock(block);
  }
  if (block.type === "table") {
    return escapeSlackPresentationTableBlock(block);
  }
  if (block.type === "buttons") {
    return {
      ...block,
      buttons: block.buttons.map((button) => {
        const commandAction = button.action?.type === "command" ? button.action : undefined;
        // Slack cannot escape backticks inside inline code; label any changed command bytes.
        const label = commandAction?.command.includes("`")
          ? `${button.label} [${SLACK_UNCOPYABLE_COMMAND_WARNING}]`
          : button.label;
        return {
          ...button,
          label: escapeSlackMrkdwn(label),
          ...(button.value ? { value: escapeSlackMrkdwn(button.value) } : {}),
          ...(button.url ? { url: escapeSlackMrkdwn(button.url) } : {}),
          ...(button.webApp ? { webApp: { url: escapeSlackMrkdwn(button.webApp.url) } } : {}),
          ...(button.web_app ? { web_app: { url: escapeSlackMrkdwn(button.web_app.url) } } : {}),
          ...(commandAction
            ? {
                action: {
                  ...commandAction,
                  command: commandAction.command.replaceAll("`", "[backtick]"),
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
  return renderMessagePresentationChartFallbackText(escapeSlackPresentationChartBlock(block));
}

export function renderSlackMessagePresentationTableFallbackText(
  block: MessagePresentationTableBlock,
): string {
  return renderMessagePresentationTableFallbackText(escapeSlackPresentationTableBlock(block));
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
