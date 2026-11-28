import {
  adaptMessagePresentationForChannel,
  renderMessagePresentationChartFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationChartBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelOutboundAdapter } from "../runtime-api.js";

export const MSTEAMS_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: true,
  divider: true,
  charts: true,
  limits: {
    actions: {
      supportsStyles: false,
      supportsDisabled: false,
    },
    text: {
      markdownDialect: "markdown",
    },
  },
} satisfies ChannelOutboundAdapter["presentationCapabilities"];

function supportsNativeChart(block: MessagePresentationChartBlock): boolean {
  return block.chartType === "pie" || block.chartType === "bar";
}

// Core advertises charts as one capability. When all data falls back and there
// are no controls, let core deliver the author's fallback text.
export function hasOnlyFallbackMSTeamsCharts(presentation: MessagePresentation): boolean {
  return (
    presentation.blocks.some((block) => block.type === "chart") &&
    !presentation.blocks.some(
      (block) =>
        block.type === "buttons" ||
        block.type === "select" ||
        (block.type === "chart" && supportsNativeChart(block)),
    )
  );
}

export function buildMSTeamsPresentationCard(params: {
  presentation: MessagePresentation;
  text?: string | null;
}) {
  const body: Record<string, unknown>[] = [];
  const text = normalizeOptionalString(params.text);
  if (text) {
    body.push({
      type: "TextBlock",
      text,
      wrap: true,
    });
  }
  const presentation = adaptMessagePresentationForChannel({
    presentation: params.presentation,
    capabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
  });
  if (presentation.title) {
    body.push({
      type: "TextBlock",
      text: presentation.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    });
  }
  const actions: Record<string, unknown>[] = [];
  let version = "1.4";
  for (const block of presentation.blocks) {
    if (block.type === "chart") {
      if (!supportsNativeChart(block)) {
        body.push({
          type: "TextBlock",
          text: renderMessagePresentationChartFallbackText(block),
          wrap: true,
          isSubtle: true,
          size: "Small",
        });
        continue;
      }
      version = "1.5";
      if (block.chartType === "pie") {
        body.push({
          type: "Chart.Pie",
          title: block.title,
          showTitle: true,
          colorSet: "categorical",
          data: block.segments.map(({ label, value }) => ({ legend: label, value })),
        });
        continue;
      }
      const axes = { xAxisTitle: block.xLabel, yAxisTitle: block.yLabel };
      const [series] = block.series;
      if (series && block.series.length === 1) {
        const needsSeriesHeading = Boolean(block.yLabel && block.yLabel !== series.name);
        const title = needsSeriesHeading ? `${block.title} (${series.name})` : block.title;
        // Teams web exposes the chart title to assistive technology but hides it visually.
        if (needsSeriesHeading) {
          body.push({ type: "TextBlock", text: title, weight: "Bolder", wrap: true });
        }
        body.push({
          type: "Chart.VerticalBar",
          title,
          showTitle: !needsSeriesHeading,
          ...axes,
          yAxisTitle: block.yLabel ?? series.name,
          data: block.categories.map((x, index) => ({ x, y: series.values[index] })),
        });
      } else {
        body.push({
          type: "Chart.VerticalBar.Grouped",
          title: block.title,
          showTitle: true,
          ...axes,
          data: block.series.map(({ name, values }) => ({
            legend: name,
            values: block.categories.map((x, index) => ({ x, y: values[index] })),
          })),
        });
      }
      continue;
    }
    if (block.type === "text" || block.type === "context") {
      body.push({
        type: "TextBlock",
        text: block.text,
        wrap: true,
        ...(block.type === "context" ? { isSubtle: true, size: "Small" } : {}),
      });
      continue;
    }
    if (block.type === "divider") {
      body.push({ type: "TextBlock", text: "---", wrap: true, isSubtle: true });
      continue;
    }
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        const action = resolveMessagePresentationButtonAction(button);
        if (action?.type === "url" || action?.type === "web-app") {
          const url = normalizeOptionalString(action.url);
          if (!url) {
            continue;
          }
          actions.push({
            type: "Action.OpenUrl",
            title: button.label,
            url,
          });
          continue;
        }
        if (action?.type === "command") {
          actions.push({
            type: "Action.Submit",
            title: button.label,
            data: action.command,
          });
          continue;
        }
        if (action?.type === "callback") {
          actions.push({
            type: "Action.Submit",
            title: button.label,
            data: { value: action.value, label: button.label },
          });
        }
      }
    }
  }
  return {
    type: "AdaptiveCard",
    version,
    body,
    ...(actions.length ? { actions } : {}),
  };
}
