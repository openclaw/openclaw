import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  escapeHelp,
  formatLabels,
  formatPrometheusNumber,
  metricKey,
  type LabelSet,
} from "./prometheus-format.js";

type ScalarSample = {
  help: string;
  key: string;
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
  key: string;
  name: string;
  sumPrefix: string;
  countPrefix: string;
  sum: number;
};

type LabelNode<T> = {
  values?: Map<string, LabelNode<T>>;
  sample?: T;
};

type LabelShape<T> = { keys: string[]; root: LabelNode<T> };
type MetricSeries<T> = { samples: T[]; shapes: Map<string, LabelShape<T>[]> };

function createSeries<T>(): MetricSeries<T> {
  return { samples: [], shapes: new Map() };
}

export type PrometheusMetricStore = ReturnType<typeof createPrometheusMetricStore>;

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];
// Match diagnostics-otel's one-hour agent range without removing existing le series.
export const AGENT_DURATION_BUCKETS_SECONDS = [...DURATION_BUCKETS_SECONDS, 900, 1800, 3600];
const MAX_PROMETHEUS_SERIES = 2048;
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";

export function createPrometheusMetricStore() {
  const counters = createSeries<ScalarSample>();
  const gauges = createSeries<ScalarSample>();
  const histograms = createSeries<HistogramSample>();
  let droppedSeries = 0;
  // Reuse the scrape workspace; render overwrites it, and reset releases it.
  const parts: string[] = [];

  const series = <T>(map: MetricSeries<T>, name: string, labels: LabelSet) => {
    let labelCount = 0;
    for (const key in labels) {
      if (Object.hasOwn(labels, key)) {
        labelCount++;
      }
    }
    let shape: LabelShape<T> | undefined;
    shapes: for (const candidate of map.shapes.get(name) ?? []) {
      if (candidate.keys.length !== labelCount) {
        continue;
      }
      let node: LabelNode<T> | undefined = candidate.root;
      for (const key of candidate.keys) {
        const value = labels[key];
        if (value === undefined || !Object.prototype.propertyIsEnumerable.call(labels, key)) {
          continue shapes;
        }
        node = node?.values?.get(value);
      }
      shape = candidate;
      if (node?.sample) {
        return node;
      }
      break;
    }
    if (
      counters.samples.length + gauges.samples.length + histograms.samples.length >=
      MAX_PROMETHEUS_SERIES
    ) {
      droppedSeries++;
      return undefined;
    }
    if (!shape) {
      // Each metric can have multiple label shapes (for example GC's optional worker slot).
      shape = {
        keys: Object.keys(labels).toSorted((left, right) => left.localeCompare(right)),
        root: {},
      };
      const shapes = map.shapes.get(name);
      if (shapes) {
        shapes.push(shape);
      } else {
        map.shapes.set(name, [shape]);
      }
    }
    let node = shape.root;
    for (const key of shape.keys) {
      const value = expectDefined(labels[key], "Prometheus label");
      const values = (node.values ??= new Map());
      let child = values.get(value);
      if (!child) {
        child = {};
        values.set(value, child);
      }
      node = child;
    }
    return node;
  };

  const scalar = (
    map: typeof counters,
    name: string,
    help: string,
    labels: LabelSet,
    value: number | undefined,
    mode: "add" | "set" | "max",
  ) => {
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      (mode !== "set" && value < 0) ||
      (mode === "add" && value === 0)
    ) {
      return;
    }
    const node = series(map, name, labels);
    if (!node) {
      return;
    }
    if (node.sample) {
      node.sample.value =
        mode === "add"
          ? node.sample.value + value
          : mode === "max"
            ? Math.max(node.sample.value, value)
            : value;
    } else {
      node.sample = {
        help,
        key: metricKey(name, labels),
        name,
        prefix: `${name}${formatLabels(labels)} `,
        value,
      };
      map.samples.push(node.sample);
    }
  };

  const counter = (name: string, help: string, labels: LabelSet, amount = 1) =>
    scalar(counters, name, help, labels, amount, "add");
  const counterValue = (name: string, help: string, labels: LabelSet, value: number) =>
    scalar(counters, name, help, labels, value, "max");
  const gauge = (name: string, help: string, labels: LabelSet, value: number | undefined) =>
    scalar(gauges, name, help, labels, value, "set");

  const clearGauges = (name: string) => {
    gauges.shapes.delete(name);
    gauges.samples = gauges.samples.filter((sample) => sample.name !== name);
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
    const node = series(histograms, name, labels);
    if (!node) {
      return;
    }
    let sample = node.sample;
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
        key: metricKey(name, labels),
        name,
        sumPrefix: `${name}_sum${formatLabels(labels)} `,
        countPrefix: `${name}_count${formatLabels(labels)} `,
        sum: 0,
      };
      node.sample = sample;
      histograms.samples.push(sample);
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
      ["counter", counters.samples],
      ["gauge", gauges.samples],
    ] as const) {
      // oxlint-disable-next-line unicorn/no-array-sort -- The store owns and reuses this scrape array.
      for (const sample of samples.sort((left, right) => left.key.localeCompare(right.key))) {
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
    // oxlint-disable-next-line unicorn/no-array-sort -- The store owns and reuses this scrape array.
    for (const sample of histograms.samples.sort((left, right) =>
      left.key.localeCompare(right.key),
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
    for (const map of [counters, gauges, histograms]) {
      map.samples.length = 0;
      map.shapes.clear();
    }
    droppedSeries = 0;
    parts.length = 0;
  };

  return { counter, counterValue, gauge, clearGauges, histogram, reset, render };
}
