import { describe, expect, it } from "vitest";
import {
  buildSlackDataVisualizationBlock,
  renderSlackDataVisualizationFallbackText,
} from "./data-visualization.js";

const title = "Quarterly revenue";
const categories = ["Q1", "Q2"];
const datum = (label: string, value: number) => ({ label, value });

describe("Slack data visualization blocks", () => {
  it("maps portable series charts to Slack's exact native shape", () => {
    expect(
      buildSlackDataVisualizationBlock({
        type: "chart",
        chartType: "line",
        title,
        categories,
        series: [
          { name: "Product", values: [120, 145] },
          { name: "Services", values: [80, 95] },
        ],
        xLabel: "Quarter",
        yLabel: "Revenue",
      }),
    ).toEqual({
      type: "data_visualization",
      title,
      chart: {
        type: "line",
        series: [
          { name: "Product", data: [datum("Q1", 120), datum("Q2", 145)] },
          { name: "Services", data: [datum("Q1", 80), datum("Q2", 95)] },
        ],
        axis_config: { categories: ["Q1", "Q2"], x_label: "Quarter", y_label: "Revenue" },
      },
    });
  });

  it("maps portable pie charts without inventing image or color fields", () => {
    expect(
      buildSlackDataVisualizationBlock({
        type: "chart",
        chartType: "pie",
        title: "Requests by region",
        segments: [
          { label: "Americas", value: 52 },
          { label: "Europe", value: 31 },
        ],
      }),
    ).toEqual({
      type: "data_visualization",
      title: "Requests by region",
      chart: {
        type: "pie",
        segments: [datum("Americas", 52), datum("Europe", 31)],
      },
    });
  });

  const invalid = { type: "chart" as const, title: "Invalid" };
  it.each([
    { ...invalid, chartType: "pie" as const, segments: [{ label: "Zero", value: 0 }] },
    {
      ...invalid,
      chartType: "bar" as const,
      categories,
      series: [{ name: "Revenue", values: [1] }],
    },
    {
      ...invalid,
      chartType: "area" as const,
      categories: ["Q1"],
      series: Array.from({ length: 13 }, (_, index) => ({
        name: `Series ${index}`,
        values: [index],
      })),
    },
  ])("rejects invalid $chartType data without clipping", (input) => {
    expect(buildSlackDataVisualizationBlock(input)).toBeUndefined();
  });

  it("orders inbound data by axis categories instead of array position", () => {
    expect(
      renderSlackDataVisualizationFallbackText({
        type: "data_visualization",
        title,
        chart: {
          type: "line",
          series: [{ name: "Revenue", data: [datum("Q2", 145), datum("Q1", 120)] }],
          axis_config: { categories },
        },
      }),
    ).toBe("Quarterly revenue (line chart)\n- Revenue: Q1: 120; Q2: 145");
  });
});
