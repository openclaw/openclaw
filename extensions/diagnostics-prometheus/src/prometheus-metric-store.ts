import { metricKey, type LabelSet } from "./prometheus-format.js";

type ScalarSample = {
  help: string;
  labels: LabelSet;
  value: number;
};

type HistogramSample = {
  buckets: number[];
  counts: number[];
  count: number;
  help: string;
  labels: LabelSet;
  sum: number;
};

export type PrometheusMetricStore = ReturnType<typeof createPrometheusMetricStore>;

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];
const MAX_PROMETHEUS_SERIES = 2048;
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";

export function createPrometheusMetricStore() {
  const counters = new Map<string, ScalarSample>();
  const gauges = new Map<string, ScalarSample>();
  const histograms = new Map<string, HistogramSample>();
  let droppedSeries = 0;

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
    counters.set(key, { help, labels, value: amount });
  };

  const gauge = (name: string, help: string, labels: LabelSet, value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    const key = metricKey(name, labels);
    if (!canCreateSeries(gauges, key)) {
      return;
    }
    gauges.set(key, { help, labels, value });
  };

  const counterValue = (name: string, help: string, labels: LabelSet, value: number) => {
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    const key = metricKey(name, labels);
    if (canCreateSeries(counters, key)) {
      counters.set(key, { help, labels, value: Math.max(counters.get(key)?.value ?? 0, value) });
    }
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
    if (value === undefined || !Number.isFinite(value) || value < 0) {
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
        counts: buckets.map(() => 0),
        count: 0,
        help,
        labels,
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

  const snapshot = () => {
    const counterSnapshot = [...counters];
    if (droppedSeries > 0) {
      counterSnapshot.push([
        metricKey(DROPPED_SERIES_COUNTER_NAME, {}),
        {
          help: "Prometheus metric series dropped because the exporter series cap was reached.",
          labels: {},
          value: droppedSeries,
        },
      ]);
    }
    return {
      counters: counterSnapshot,
      gauges: [...gauges],
      histograms: [...histograms],
    };
  };

  const reset = () => {
    counters.clear();
    gauges.clear();
    histograms.clear();
    droppedSeries = 0;
  };

  return { counter, counterValue, gauge, clearGauges, histogram, reset, snapshot };
}
