import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";

export type LabelSet = Record<string, string>;

export function sortedLabels(labels: LabelSet): [string, string][] {
  const entries = Object.entries(labels);
  entries.sort(([left], [right]) => left.localeCompare(right));
  return entries;
}

export function metricKey(name: string, labels: LabelSet): string {
  return `${name}|${JSON.stringify(sortedLabels(labels))}`;
}

export function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export function formatLabelEntry([key, value]: [string, string]): string {
  return `${key}="${escapeLabelValue(value)}"`;
}

export function formatLabels(labels: LabelSet): string {
  const entries = sortedLabels(labels);
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(formatLabelEntry).join(",")}}`;
}

export function formatPrometheusNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

export function seconds(ms: number | undefined): number | undefined {
  const value = numericValue(ms);
  return value === undefined ? undefined : value / 1000;
}
