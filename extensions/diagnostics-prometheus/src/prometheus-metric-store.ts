/// <reference lib="es2024.arraybuffer" />
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  MAX_PROMETHEUS_FAMILY_SERIES,
  PROMETHEUS_FAMILY_RESERVES,
  SHARED_PROMETHEUS_SERIES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
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
  prefix: Buffer;
  value: number;
  rendered?: Uint8Array;
  renderedDirty: boolean;
};

type HistogramSample = {
  buckets: number[];
  bucketPrefixes: Buffer[];
  counts: number[];
  count: number;
  help: string;
  key: string;
  name: string;
  sumPrefix: Buffer;
  countPrefix: Buffer;
  sum: number;
  rendered?: Uint8Array;
  renderedDirty: boolean;
};

type LabelNode<T> = {
  values?: Map<string, LabelNode<T>>;
  sample?: T;
};

type LabelShape<T> = { keys: string[]; root: LabelNode<T> };
type MetricSeries<T> = { samples: T[]; shapes: Map<string, LabelShape<T>[]>; sorted: boolean };

function createSeries<T>(): MetricSeries<T> {
  return { samples: [], shapes: new Map(), sorted: true };
}

function sortedSamples<T extends { key: string }>(series: MetricSeries<T>): T[] {
  if (!series.sorted) {
    series.samples.sort((left, right) => left.key.localeCompare(right.key));
    series.sorted = true;
  }
  return series.samples;
}

export type PrometheusMetricStore = ReturnType<typeof createPrometheusMetricStore>;

const DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];
// Match diagnostics-otel's one-hour agent range without removing existing le series.
export const AGENT_DURATION_BUCKETS_SECONDS = [...DURATION_BUCKETS_SECONDS, 900, 1800, 3600];
const DROPPED_SERIES_COUNTER_NAME = "openclaw_prometheus_series_dropped_total";

const DROPPED_FAMILY_COUNTER_NAME = "openclaw_prometheus_family_series_dropped_total";
// Exporter stop/start resets counters, but warnings are once per family per process.
const warnedFamilies = new Set<PrometheusMetricName>();

export function createPrometheusMetricStore(
  onSeriesDropped?: (name: PrometheusMetricName) => void,
) {
  const counters = createSeries<ScalarSample>();
  const gauges = createSeries<ScalarSample>();
  const histograms = createSeries<HistogramSample>();
  let droppedSeries = 0;
  let sharedSeries = 0;
  const familyCounts = new Map<PrometheusMetricName, number>();
  const familyDrops = new Map<PrometheusMetricName, number>();
  const headers = new Map<string, { type: string; help: string; bytes: Buffer }>();
  // Prefix views share only exporter-owned chunks, never unrelated Buffer-pool traffic.
  let prefixBuffer = Buffer.alloc(0);
  let prefixOffset = 0;
  const encodePrefix = (text: string) => {
    const bytes = Buffer.byteLength(text);
    if (bytes > 4 * 1024) {
      const prefix = Buffer.allocUnsafeSlow(bytes);
      prefix.write(text);
      return prefix;
    }
    if (prefixOffset + bytes > prefixBuffer.length) {
      prefixBuffer = Buffer.allocUnsafeSlow(4 * 1024);
      prefixOffset = 0;
    }
    const start = prefixOffset;
    prefixOffset += prefixBuffer.write(text, prefixOffset);
    return prefixBuffer.subarray(start, prefixOffset);
  };
  // Scratch for one changed series; cached blocks never share response backing storage.
  let scratch = Buffer.alloc(0);

  const series = <T>(map: MetricSeries<T>, name: PrometheusMetricName, labels: LabelSet) => {
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
    const count = familyCounts.get(name) ?? 0;
    const reserve = PROMETHEUS_FAMILY_RESERVES[name];
    if (
      count >= Math.max(MAX_PROMETHEUS_FAMILY_SERIES, reserve) ||
      (count >= reserve && sharedSeries >= SHARED_PROMETHEUS_SERIES)
    ) {
      droppedSeries++;
      familyDrops.set(name, (familyDrops.get(name) ?? 0) + 1);
      if (onSeriesDropped && !warnedFamilies.has(name)) {
        warnedFamilies.add(name);
        onSeriesDropped(name);
      }
      return undefined;
    }
    familyCounts.set(name, count + 1);
    if (count >= reserve) {
      sharedSeries++;
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
    name: PrometheusMetricName,
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
      const next =
        mode === "add"
          ? node.sample.value + value
          : mode === "max"
            ? Math.max(node.sample.value, value)
            : value;
      if (next !== node.sample.value) {
        node.sample.value = next;
        node.sample.renderedDirty = true;
      }
    } else {
      node.sample = {
        help,
        key: metricKey(name, labels),
        name,
        prefix: encodePrefix(`${name}${formatLabels(labels)} `),
        value,
        renderedDirty: true,
      };
      map.samples.push(node.sample);
      map.sorted = false;
    }
  };

  const counter = (name: PrometheusMetricName, help: string, labels: LabelSet, amount = 1) =>
    scalar(counters, name, help, labels, amount, "add");
  const counterValue = (
    name: PrometheusMetricName,
    help: string,
    labels: LabelSet,
    value: number,
  ) => scalar(counters, name, help, labels, value, "max");
  const gauge = (
    name: PrometheusMetricName,
    help: string,
    labels: LabelSet,
    value: number | undefined,
  ) => scalar(gauges, name, help, labels, value, "set");

  const clearGauges = (name: PrometheusMetricName) => {
    headers.delete(name);
    const previousLength = gauges.samples.length;
    gauges.shapes.delete(name);
    gauges.samples = gauges.samples.filter((sample) => sample.name !== name);
    const count = familyCounts.get(name) ?? 0;
    const remaining = count - (previousLength - gauges.samples.length);
    const reserve = PROMETHEUS_FAMILY_RESERVES[name];
    sharedSeries -= Math.max(0, count - reserve) - Math.max(0, remaining - reserve);
    familyCounts.set(name, remaining);
  };

  const getHistogram = (
    name: PrometheusMetricName,
    help: string,
    labels: LabelSet,
    buckets = DURATION_BUCKETS_SECONDS,
  ) => {
    const node = series(histograms, name, labels);
    if (!node) {
      return undefined;
    }
    let sample = node.sample;
    if (!sample) {
      sample = {
        buckets,
        // Labels and bounds are fixed for this series; reset releases the prepared text.
        bucketPrefixes: [...buckets, "+Inf"].map((le) =>
          encodePrefix(`${name}_bucket${formatLabels({ ...labels, le: String(le) })} `),
        ),
        counts: buckets.map(() => 0),
        count: 0,
        help,
        key: metricKey(name, labels),
        name,
        sumPrefix: encodePrefix(`${name}_sum${formatLabels(labels)} `),
        countPrefix: encodePrefix(`${name}_count${formatLabels(labels)} `),
        sum: 0,
        renderedDirty: true,
      };
      node.sample = sample;
      histograms.samples.push(sample);
      histograms.sorted = false;
    }
    return sample;
  };

  const reserveHistogram = (name: PrometheusMetricName, help: string, labels: LabelSet) => {
    getHistogram(name, help, labels);
  };

  const histogram = (
    name: PrometheusMetricName,
    help: string,
    labels: LabelSet,
    value: number | undefined,
    buckets = DURATION_BUCKETS_SECONDS,
  ) => {
    if (value === undefined || !Number.isFinite(value)) {
      return;
    }
    const sample = getHistogram(name, help, labels, buckets);
    if (!sample) {
      return;
    }
    sample.count += 1;
    sample.sum += value;
    sample.renderedDirty = true;
    for (let index = 0; index < sample.buckets.length; index += 1) {
      const bucket = sample.buckets[index];
      if (bucket !== undefined && value <= bucket) {
        sample.counts[index] = (sample.counts[index] ?? 0) + 1;
      }
    }
  };

  const render = () => {
    let scratchOffset = 0;
    let totalBytes = 0;
    const chunks: Uint8Array[] = [];
    const append = (chunk: Uint8Array) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    };
    const write = (prefix: Buffer, value: number) => {
      const number = formatPrometheusNumber(value);
      const required = scratchOffset + prefix.length + number.length + 1;
      if (required > scratch.length) {
        const grown = Buffer.allocUnsafeSlow(Math.max(required, scratch.length * 2));
        grown.set(scratch.subarray(0, scratchOffset));
        scratch = grown;
      }
      scratch.set(prefix, scratchOffset);
      scratchOffset += prefix.length;
      scratchOffset += scratch.write(number, scratchOffset, "ascii");
      scratch[scratchOffset++] = 10;
    };
    const finish = (previous?: Uint8Array) => {
      const output = previous?.length === scratchOffset ? previous : new Uint8Array(scratchOffset);
      scratch.copy(output, 0, 0, scratchOffset);
      scratchOffset = 0;
      return output;
    };
    const emitted = new Set<string>();
    let previousName: string | undefined;
    const header = (name: string, type: string, help: string) => {
      if (previousName === name) {
        return;
      }
      previousName = name;
      if (!emitted.has(name)) {
        emitted.add(name);
        let cached = headers.get(name);
        // The first sorted series owns the header; admission/removal can change that owner.
        if (!cached || cached.type !== type || cached.help !== help) {
          cached = {
            type,
            help,
            bytes: encodePrefix(`# HELP ${name} ${escapeHelp(help)}\n# TYPE ${name} ${type}\n`),
          };
          headers.set(name, cached);
        }
        append(cached.bytes);
      }
    };
    for (const [type, map] of [
      ["counter", counters],
      ["gauge", gauges],
    ] as const) {
      for (const sample of sortedSamples(map)) {
        header(sample.name, type, sample.help);
        if (!sample.rendered || sample.renderedDirty) {
          write(sample.prefix, sample.value);
          sample.rendered = finish(sample.rendered);
          sample.renderedDirty = false;
        }
        append(sample.rendered);
      }
      if (type === "counter" && droppedSeries > 0) {
        header(
          DROPPED_SERIES_COUNTER_NAME,
          type,
          "New-series observations dropped because an exporter series budget was reached.",
        );
        write(Buffer.from(`${DROPPED_SERIES_COUNTER_NAME} `), droppedSeries);
        append(finish());
        header(
          DROPPED_FAMILY_COUNTER_NAME,
          type,
          "New-series observations dropped by bounded metric family.",
        );
        for (const [family, count] of familyDrops) {
          write(Buffer.from(`${DROPPED_FAMILY_COUNTER_NAME}${formatLabels({ family })} `), count);
        }
        append(finish());
      }
    }
    for (const sample of sortedSamples(histograms)) {
      if (sample.count === 0) {
        continue;
      }
      header(sample.name, "histogram", sample.help);
      if (!sample.rendered || sample.renderedDirty) {
        sample.bucketPrefixes.forEach((prefix, bucketIndex) => {
          write(prefix, sample.counts[bucketIndex] ?? sample.count);
        });
        write(sample.sumPrefix, sample.sum);
        write(sample.countPrefix, sample.count);
        sample.rendered = finish(sample.rendered);
        sample.renderedDirty = false;
      }
      append(sample.rendered);
    }
    // A private backing store lets the HTTP owner release bytes after the write completes.
    const output = Buffer.from(new ArrayBuffer(totalBytes));
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  };

  const reset = () => {
    for (const map of [counters, gauges, histograms]) {
      map.samples.length = 0;
      map.shapes.clear();
    }
    droppedSeries = 0;
    sharedSeries = 0;
    familyCounts.clear();
    familyDrops.clear();
    headers.clear();
    scratch = Buffer.alloc(0);
    prefixBuffer = Buffer.alloc(0);
    prefixOffset = 0;
  };

  return { counter, counterValue, gauge, clearGauges, histogram, reserveHistogram, reset, render };
}
