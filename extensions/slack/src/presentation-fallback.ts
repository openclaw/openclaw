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

function escapeSlackPresentationChartBlock(
  block: MessagePresentationChartBlock,
): MessagePresentationChartBlock {
  if (block.chartType === "pie") {
    return {
      ...block,
      title: escapeSlackMrkdwn(block.title),
      segments: block.segments.map((segment) => ({
        ...segment,
        label: escapeSlackMrkdwn(segment.label),
      })),
    };
  }
  return {
    ...block,
    title: escapeSlackMrkdwn(block.title),
    categories: block.categories.map(escapeSlackMrkdwn),
    series: block.series.map((series) => ({
      ...series,
      name: escapeSlackMrkdwn(series.name),
    })),
    ...(block.xLabel ? { xLabel: escapeSlackMrkdwn(block.xLabel) } : {}),
    ...(block.yLabel ? { yLabel: escapeSlackMrkdwn(block.yLabel) } : {}),
  };
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
      buttons: block.buttons.map((button) => ({
        ...button,
        label: escapeSlackMrkdwn(button.label),
        ...(button.value ? { value: escapeSlackMrkdwn(button.value) } : {}),
        ...(button.url ? { url: escapeSlackMrkdwn(button.url) } : {}),
        ...(button.webApp ? { webApp: { url: escapeSlackMrkdwn(button.webApp.url) } } : {}),
        ...(button.web_app ? { web_app: { url: escapeSlackMrkdwn(button.web_app.url) } } : {}),
        ...(button.action?.type === "command"
          ? {
              action: {
                ...button.action,
                command: escapeSlackMrkdwn(button.action.command),
              },
            }
          : {}),
      })),
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
