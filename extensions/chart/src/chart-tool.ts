import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { imageResultFromFile } from "openclaw/plugin-sdk/channel-actions";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { type ChartType, renderChartSVG } from "./render-svg.js";

const CHART_TYPES: readonly ChartType[] = ["bar", "line", "pie", "scatter", "area"];

export const ChartToolSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      description: "Chart type: bar, line, pie, scatter, or area.",
      enum: CHART_TYPES,
    },
    title: { type: "string", description: "Optional chart title." },
    labels: {
      type: "array",
      items: { type: "string" },
      description: "Labels for the x-axis, or segment names for pie charts.",
    },
    series: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Series name shown in the legend." },
          values: {
            type: "array",
            items: { type: "number" },
            description: "Data values for this series. Must have the same length as labels.",
          },
          color: { type: "string", description: "Optional hex color (e.g. #4E79A7)." },
        },
        required: ["label", "values"],
        additionalProperties: false,
      },
      description: "One or more data series to plot.",
    },
    width: {
      type: "integer",
      description: "Image width in pixels (200–4000, default 800).",
      minimum: 200,
      maximum: 4000,
    },
    height: {
      type: "integer",
      description: "Image height in pixels (200–4000, default 500).",
      minimum: 200,
      maximum: 4000,
    },
    xLabel: { type: "string", description: "Optional label for the x-axis." },
    yLabel: { type: "string", description: "Optional label for the y-axis." },
    showLegend: {
      type: "boolean",
      description: "Whether to show the legend. Defaults to true for multi-series charts.",
    },
  },
  required: ["type", "labels", "series"],
  additionalProperties: false,
};

type ChartSeriesInput = { label: string; values: number[]; color?: string };

function parseSeries(raw: unknown, labelsLen: number): ChartSeriesInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('The "series" parameter must be a non-empty array.');
  }
  return raw.map((item: unknown, idx: number) => {
    if (!item || typeof item !== "object") {
      throw new Error(`series[${idx}] must be an object with "label" and "values" fields.`);
    }
    const obj = item as Record<string, unknown>;
    const label =
      typeof obj.label === "string" && obj.label.trim() ? obj.label : `Series ${idx + 1}`;
    const values = Array.isArray(obj.values) ? obj.values.map(Number) : [];
    if (values.length !== labelsLen) {
      throw new Error(
        `series[${idx}] ("${label}"): values length (${values.length}) ` +
          `does not match labels length (${labelsLen}). Each series must have one value per label.`,
      );
    }
    const color = typeof obj.color === "string" ? obj.color : undefined;
    return { label, values, color };
  });
}

export function createChartTool(): AnyAgentTool {
  return {
    name: "chart",
    label: "Generate Chart",
    description:
      "Generate a chart (bar, line, pie, scatter, or area) from structured data as an SVG image. " +
      "Use this to visualize data, create reports, or show trends. " +
      "Each series must have the same number of values as the labels array.",
    parameters: ChartToolSchema,
    execute: async (...executeArgs: Parameters<AnyAgentTool["execute"]>) => {
      const [, args] = executeArgs;
      const a = args as Record<string, unknown>;

      const chartType = readStringParam(a, "type", { required: true }) as ChartType;
      if (!CHART_TYPES.includes(chartType)) {
        throw new Error(
          `Unknown chart type "${chartType}". Valid types: ${CHART_TYPES.join(", ")}.`,
        );
      }

      const labels = readStringArrayParam(a, "labels", { required: true });
      if (labels.length === 0) {
        throw new Error('The "labels" array must not be empty.');
      }
      if (labels.length > 100) {
        throw new Error(`Too many labels (${labels.length}). Maximum is 100.`);
      }

      const series = parseSeries(a.series, labels.length);
      const title = readStringParam(a, "title");
      const w = readNumberParam(a, "width", { integer: true });
      const h = readNumberParam(a, "height", { integer: true });
      const width = Math.max(200, Math.min(4000, typeof w === "number" ? w : 800));
      const height = Math.max(200, Math.min(4000, typeof h === "number" ? h : 500));
      const showLegend = a.showLegend !== false;

      const svg = renderChartSVG({
        type: chartType,
        title,
        width,
        height,
        labels,
        series,
        xLabel: readStringParam(a, "xLabel"),
        yLabel: readStringParam(a, "yLabel"),
        legend: showLegend,
      });

      const dir = path.join(resolvePreferredOpenClawTmpDir(), "charts");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `chart-${chartType}-${randomUUID().slice(0, 8)}.svg`);
      await fs.writeFile(filePath, svg, "utf-8");

      return imageResultFromFile({ label: `chart-${chartType}`, path: filePath });
    },
  };
}
