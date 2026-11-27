/// <reference lib="es2024.arraybuffer" />
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { PluginMetricFamily } from "../api.js";
import {
  MAX_PROMETHEUS_FAMILY_SERIES,
  MAX_PROMETHEUS_SERIES,
  PROMETHEUS_FAMILY_LIMITS,
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
  buckets: readonly number[];
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
const RESPONSE_BLOCK_BYTES = 4096;
// Exporter stop/start resets counters, but warnings are once per family per process.
const warnedFamilies = new Set<string>();

const isCoreFamily = (name: string): name is PrometheusMetricName =>
  Object.hasOwn(PROMETHEUS_FAMILY_LIMITS, name);
const limitFor = (name: string): number =>
  isCoreFamily(name) ? PROMETHEUS_FAMILY_LIMITS[name] : MAX_PROMETHEUS_FAMILY_SERIES;

export function createPrometheusMetricStore(onSeriesDropped?: (name: string) => void) {
  const counters = createSeries<ScalarSample>();
  const gauges = createSeries<ScalarSample>();
  const histograms = createSeries<HistogramSample>();
  let droppedSeries = 0;
  let retainedSeries = 0;
  const familyCounts = new Map<string, number>();
  const familyDrops = new Map<string, { count: number; prefix: Buffer }>();
  let droppedPrefix: Buffer | undefined;
  let replacedGauges: typeof gauges.shapes | undefined;
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
  let responseCapacity = 0;

  const series = <T>(
    shapesByName: MetricSeries<T>["shapes"],
    name: string,
    labels: LabelSet,
    admit = true,
  ) => {
    const shapes = shapesByName.get(name);
    if (!shapes && !admit) {
      return undefined;
    }
    let labelCount = 0;
    for (const key in labels) {
      if (Object.hasOwn(labels, key)) {
        labelCount++;
      }
    }
    let shape: LabelShape<T> | undefined;
    candidates: for (const candidate of shapes ?? []) {
      if (candidate.keys.length !== labelCount) {
        continue;
      }
      let node: LabelNode<T> | undefined = candidate.root;
      for (const key of candidate.keys) {
        const value = labels[key];
        if (value === undefined || !Object.prototype.propertyIsEnumerable.call(labels, key)) {
          continue candidates;
        }
        node = node?.values?.get(value);
      }
      shape = candidate;
      if (node?.sample) {
        return node;
      }
      break;
    }
    if (!admit) {
      return undefined;
    }
    const count = familyCounts.get(name) ?? 0;
    if (count >= limitFor(name) || retainedSeries >= MAX_PROMETHEUS_SERIES) {
      droppedSeries++;
      const drop = familyDrops.get(name);
      if (drop) {
        drop.count++;
      } else {
        familyDrops.set(name, {
          count: 1,
          prefix: encodePrefix(`${DROPPED_FAMILY_COUNTER_NAME}${formatLabels({ family: name })} `),
        });
      }
      if (onSeriesDropped && !warnedFamilies.has(name)) {
        warnedFamilies.add(name);
        onSeriesDropped(name);
      }
      return undefined;
    }
    familyCounts.set(name, count + 1);
    retainedSeries++;
    if (!shape) {
      // Each metric can have multiple label shapes (for example GC's optional worker slot).
      shape = {
        keys: Object.keys(labels).toSorted((left, right) => left.localeCompare(right)),
        root: {},
      };
      if (shapes) {
        shapes.push(shape);
      } else {
        shapesByName.set(name, [shape]);
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
    const node = series(map.shapes, name, labels);
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
      const previous =
        replacedGauges && map === gauges
          ? series(replacedGauges, name, labels, false)?.sample
          : undefined;
      node.sample = previous ?? {
        help,
        key: metricKey(name, labels),
        name,
        prefix: encodePrefix(`${name}${formatLabels(labels)} `),
        value,
        renderedDirty: true,
      };
      if (previous) {
        previous.help = help;
        previous.renderedDirty ||= previous.value !== value;
        previous.value = value;
      }
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
    const shapes = gauges.shapes.get(name);
    if (!shapes) {
      return;
    }
    replacedGauges?.set(name, shapes);
    headers.delete(name);
    const previousLength = gauges.samples.length;
    gauges.shapes.delete(name);
    gauges.samples = gauges.samples.filter((sample) => sample.name !== name);
    const removed = previousLength - gauges.samples.length;
    retainedSeries -= removed;
    familyCounts.set(name, (familyCounts.get(name) ?? 0) - removed);
  };

  /** Withdraw stale rows while reusing prepared bytes for series present in both snapshots. */
  const replaceGaugeSnapshot = (record: () => void) => {
    replacedGauges = new Map();
    try {
      record();
    } finally {
      replacedGauges = undefined;
    }
  };

  const getHistogram = (
    name: string,
    help: string,
    labels: LabelSet,
    buckets: readonly number[] = DURATION_BUCKETS_SECONDS,
  ) => {
    const node = series(histograms.shapes, name, labels);
    if (!node) {
      return undefined;
    }
    let sample = node.sample;
    if (!sample) {
      const labelText = formatLabels(labels);
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
        sumPrefix: encodePrefix(`${name}_sum${labelText} `),
        countPrefix: encodePrefix(`${name}_count${labelText} `),
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

  const recordHistogram = (
    name: string,
    help: string,
    labels: LabelSet,
    value: number | undefined,
    buckets: readonly number[] = DURATION_BUCKETS_SECONDS,
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
    // Bounds are fixed and ascending; cumulative counts are needed only at scrape time.
    for (let index = 0; index < sample.buckets.length; index += 1) {
      const bucket = sample.buckets[index];
      if (bucket !== undefined && value <= bucket) {
        sample.counts[index] = (sample.counts[index] ?? 0) + 1;
        break;
      }
    }
  };

  const histogram = (
    name: PrometheusMetricName,
    help: string,
    labels: LabelSet,
    value: number | undefined,
    buckets?: readonly number[],
  ) => recordHistogram(name, help, labels, value, buckets);

  /** Host-admitted plugin family; its name, labels and buckets were validated at registration. */
  const plugin = (family: PluginMetricFamily, labels: Readonly<LabelSet>, value: number) => {
    if (family.type === "histogram") {
      recordHistogram(family.name, family.help, labels, value, family.buckets);
    } else {
      // inc(labels, 0) exports a known label set at 0; max keeps an existing series unchanged.
      scalar(
        family.type === "counter" ? counters : gauges,
        family.name,
        family.help,
        labels,
        value,
        family.type === "counter" ? (value === 0 ? "max" : "add") : "set",
      );
    }
  };

  /** Drop every series and header of retired plugin families and release their budget. */
  const retire = (names: readonly string[]) => {
    const retired = new Set(names);
    const drop = <T extends { name: string }>(map: MetricSeries<T>) => {
      if (map.samples.some((sample) => retired.has(sample.name))) {
        map.samples = map.samples.filter((sample) => !retired.has(sample.name));
      }
      for (const name of retired) {
        map.shapes.delete(name);
      }
    };
    drop(counters);
    drop(gauges);
    drop(histograms);
    for (const name of retired) {
      headers.delete(name);
      retainedSeries -= familyCounts.get(name) ?? 0;
      familyCounts.delete(name);
    }
  };

  const render = () => {
    let scratchOffset = 0;
    let offset = 0;
    let output = Buffer.alloc(responseCapacity);
    const append = (chunk: Uint8Array) => {
      const end = offset + chunk.length;
      if (end > output.length) {
        const grown = Buffer.alloc(Math.max(end, output.length * 2));
        grown.set(output.subarray(0, offset));
        output = grown;
      }
      output.set(chunk, offset);
      offset = end;
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
      const block = previous?.length === scratchOffset ? previous : new Uint8Array(scratchOffset);
      scratch.copy(block, 0, 0, scratchOffset);
      scratchOffset = 0;
      return block;
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
        write((droppedPrefix ??= encodePrefix(`${DROPPED_SERIES_COUNTER_NAME} `)), droppedSeries);
        append(finish());
        header(
          DROPPED_FAMILY_COUNTER_NAME,
          type,
          "New-series observations dropped by bounded metric family.",
        );
        for (const { prefix, count } of familyDrops.values()) {
          write(prefix, count);
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
        let cumulative = 0;
        for (let bucketIndex = 0; bucketIndex < sample.counts.length; bucketIndex++) {
          cumulative += sample.counts[bucketIndex]!;
          write(sample.bucketPrefixes[bucketIndex]!, cumulative);
        }
        write(sample.bucketPrefixes[sample.counts.length]!, sample.count);
        write(sample.sumPrefix, sample.sum);
        write(sample.countPrefix, sample.count);
        sample.rendered = finish(sample.rendered);
        sample.renderedDirty = false;
      }
      append(sample.rendered);
    }
    // Round capacity so changing a number's width rarely forces a response copy.
    responseCapacity = Math.ceil(offset / RESPONSE_BLOCK_BYTES) * RESPONSE_BLOCK_BYTES;
    if (output.length !== responseCapacity) {
      output = Buffer.from(output.buffer.transfer(responseCapacity));
    }
    // The HTTP owner can release this private backing store after the write completes.
    return output.subarray(0, offset);
  };

  const reset = () => {
    for (const map of [counters, gauges, histograms]) {
      map.samples.length = 0;
      map.shapes.clear();
    }
    droppedSeries = 0;
    retainedSeries = 0;
    familyCounts.clear();
    familyDrops.clear();
    droppedPrefix = undefined;
    headers.clear();
    scratch = Buffer.alloc(0);
    responseCapacity = 0;
    prefixBuffer = Buffer.alloc(0);
    prefixOffset = 0;
  };

  return {
    counter,
    counterValue,
    gauge,
    clearGauges,
    replaceGaugeSnapshot,
    histogram,
    plugin,
    reserveHistogram,
    retire,
    reset,
    render,
  };
}
