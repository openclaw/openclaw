import {
  escapeHelp,
  formatLabels,
  formatPrometheusNumber,
  metricKey,
  type LabelSet,
} from "./prometheus-format.js";

type ScalarSample = {
  help: string;
  name: string;
  prefix: string;
  value: number;
};

type HistogramSample = {
  buckets: number[];
  bucketPrefixes: string[];
  counts: number[];
  count: number;
  help: string;
  name: string;
  sumPrefix: string;
  countPrefix: string;
  sum: number;
};

export type PrometheusMetricStore = ReturnType<typeof createPrometheusMetricStore>;

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];
// Match diagnostics-otel's one-hour agent range without removing existing le series.
export const AGENT_DURATION_BUCKETS_SECONDS = [...DURATION_BUCKETS_SECONDS, 900, 1800, 3600];
const MAX_PROMETHEUS_SERIES = 2048;
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";

export function createPrometheusMetricStore() {
  const counters = new Map<string, ScalarSample>();
  const gauges = new Map<string, ScalarSample>();
  const histograms = new Map<string, HistogramSample>();
  let droppedSeries = 0;
  // Reuse the scrape workspace; render overwrites it, and reset releases it.
  const parts: string[] = [];

  const canCreateSeries = <T>(map: Map<string, T>, key: string): boolean => {
    if (map.has(key)) {
      return true;
    }
    if (counters.size + gauges.size + histograms.size < MAX_PROMETHEUS_SERIES) {
      return true;
    }
    droppedSeries += 1;
    return false;
  };

  const counter = (name: string, help: string, labels: LabelSet, amount = 1) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(counters, key)) {
      return;
    }
    const existing = counters.get(key);
    if (existing) {
      existing.value += amount;
      return;
    }
    counters.set(key, { help, name, prefix: `${name}${formatLabels(labels)} `, value: amount });
  };

  const gauge = (name: string, help: string, labels: LabelSet, value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(gauges, key)) {
      return;
    }
    const existing = gauges.get(key);
    if (existing) {
      existing.value = value;
      return;
    }
    gauges.set(key, { help, name, prefix: `${name}${formatLabels(labels)} `, value });
  };

  const counterValue = (name: string, help: string, labels: LabelSet, value: number) => {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(counters, key)) {
      return;
    }
    const existing = counters.get(key);
    if (existing) {
      existing.value = Math.max(existing.value, value);
      return;
    }
    counters.set(key, { help, name, prefix: `${name}${formatLabels(labels)} `, value });
  };

  const clearGauges = (name: string) => {
    for (const key of gauges.keys()) {
      if (key.startsWith(`${name}|`)) {
        gauges.delete(key);
      }
    }
  };

  const histogram = (
    name: string,
    help: string,
    labels: LabelSet,
    value: number | undefined,
    buckets = DURATION_BUCKETS_SECONDS,
  ) => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(histograms, key)) {
      return;
    }
    let sample = histograms.get(key);
    if (!sample) {
      sample = {
        buckets,
        // Labels and bounds are fixed for this series; reset releases the prepared text.
        bucketPrefixes: [...buckets, "+Inf"].map(
          (le) => `${name}_bucket${formatLabels({ ...labels, le: String(le) })} `,
        ),
        counts: buckets.map(() => 0),
        count: 0,
        help,
        name,
        sumPrefix: `${name}_sum${formatLabels(labels)} `,
        countPrefix: `${name}_count${formatLabels(labels)} `,
        sum: 0,
      };
      histograms.set(key, sample);
    }
    sample.count += 1;
    sample.sum += value;
    for (let index = 0; index < sample.buckets.length; index += 1) {
      const bucket = sample.buckets[index];
      if (bucket !== undefined && value <= bucket) {
        sample.counts[index] = (sample.counts[index] ?? 0) + 1;
      }
    }
  };

  const render = () => {
    let index = 0;
    const write = (prefix: string, value: number) => {
      parts[index++] = prefix;
      parts[index++] = formatPrometheusNumber(value);
      parts[index++] = "\n";
    };
    const emitted = new Set<string>();
    const header = (name: string, type: string, help: string) => {
      if (!emitted.has(name)) {
        emitted.add(name);
        parts[index++] = `# HELP ${name} ${escapeHelp(help)}\n# TYPE ${name} ${type}\n`;
      }
    };
    for (const [type, samples] of [
      ["counter", counters],
      ["gauge", gauges],
    ] as const) {
      for (const [, sample] of [...samples].toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        header(sample.name, type, sample.help);
        write(sample.prefix, sample.value);
      }
      if (type === "counter" && droppedSeries > 0) {
        header(
          DROPPED_SERIES_COUNTER_NAME,
          type,
          "Prometheus metric series dropped because the exporter series cap was reached.",
        );
        write(`${DROPPED_SERIES_COUNTER_NAME} `, droppedSeries);
      }
    }
    for (const [, sample] of [...histograms].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      header(sample.name, "histogram", sample.help);
      sample.bucketPrefixes.forEach((prefix, bucketIndex) => {
        write(prefix, sample.counts[bucketIndex] ?? sample.count);
      });
      write(sample.sumPrefix, sample.sum);
      write(sample.countPrefix, sample.count);
    }
    parts.length = index;
    return parts.join("");
  };

  const reset = () => {
    counters.clear();
    gauges.clear();
    histograms.clear();
    droppedSeries = 0;
    parts.length = 0;
  };

  return { counter, counterValue, gauge, clearGauges, histogram, reset, render };
}
