import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, expect, it, vi } from "vitest";
import renderShape from "../benchmarks/render-shape.json" with { type: "json" };
import {
  PROMETHEUS_FAMILY_RESERVES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
import * as prometheusFormat from "./prometheus-format.js";
import { createPrometheusMetricStore } from "./prometheus-metric-store.js";

const runs = "openclaw_run_completed_total";
const duration = "openclaw_run_duration_seconds";
const depth = "openclaw_worker_queue_depth";
const header = (name: string, help: string, type: string) =>
  `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
const samples = (text: string, prefix: string) =>
  text.split("\n").filter((line) => line.startsWith(prefix));
function expectLines(text: string, ...lines: string[]) {
  for (const line of lines) {
    expect(text).toContain(`${line}\n`);
  }
}
afterEach(() => vi.restoreAllMocks());

it("preserves the observed registry's golden exposition across cold and warm scrapes", () => {
  const store = createPrometheusMetricStore();
  const histogramHelp = "Synthetic histogram";
  const scalarHelp = "Synthetic scalar";
  for (const { name, labelSets, finiteBuckets } of renderShape.histograms) {
    for (let index = 0; index < labelSets; index++) {
      const labels = { kind: `kind-${index % 8}`, worker_slot: String(index) };
      const value = 0.005 * ((index % 17) + 1);
      store.histogram(name as PrometheusMetricName, histogramHelp, labels, value, finiteBuckets);
    }
  }
  for (const { name, labelSets, type } of renderShape.scalars) {
    for (let index = 0; index < labelSets; index++) {
      const record = store[type === "counter" ? "counter" : "gauge"];
      const labels = { kind: `kind-${index % 8}`, worker_slot: String(index) };
      record(name as PrometheusMetricName, scalarHelp, labels, index + 1);
    }
  }
  // Captured from the pre-optimization owner benchmark: 4,628 series / 60,154 rows.
  for (let scrape = 0; scrape < 2; scrape++) {
    const rendered = store.render();
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      "8bca72cac3d5f446991fa7c930ee2f81d56ec23d4f4afba9c4b514feb8a71cce",
    );
    rendered.buffer.transfer(0);
  }
});

it("caches headers and series independently across interleaved scrapes and updates", () => {
  const first = createPrometheusMetricStore();
  const second = createPrometheusMetricStore();
  for (const worker of ["z", "m"]) {
    first.counter(runs, "Runs.", { worker });
    first.histogram(duration, "Duration.", { worker }, 1, [1]);
  }
  first.gauge(depth, "Runs.", {}, 0.125);
  first.histogram(duration, "Duration.", {}, 0.015, [1]);
  second.histogram(duration, "Duration.", {}, 0.025, [1]);
  second.counter(runs, "Other runs.", {});
  const format = vi.spyOn(prometheusFormat, "escapeHelp");
  const numbers = vi.spyOn(Number.prototype, "toPrecision");
  first.render();
  second.render();
  format.mockClear();
  numbers.mockClear();

  first.counter(runs, "Ignored replacement help.", { worker: "z" });
  first.gauge(depth, "Runs.", {}, 0.125);
  second.render();
  const membership = vi.spyOn(Set.prototype, "has");
  first.render();
  const checks = membership.mock.calls.length;
  membership.mockRestore();
  expect(checks).toBe(3);
  expect(format).not.toHaveBeenCalled();
  expect(numbers).not.toHaveBeenCalled();

  first.gauge(depth, "Runs.", {}, 2);
  first.histogram(duration, "Duration.", {}, 0.02, [1]);
  expectLines(first.render().toString(), `${duration}_sum 0.035`, `${depth} 2`);
  expectLines(second.render().toString(), `${duration}_sum 0.025`);
  expect(numbers).toHaveBeenCalledTimes(1);
  expect(format).not.toHaveBeenCalled();

  // A newly admitted series can sort ahead of the previous header owner.
  first.counter(runs, "Earlier runs.\n", { worker: "a" });
  expectLines(first.render().toString(), `# HELP ${runs} Earlier runs.\\n`);
  expect(format).toHaveBeenCalledTimes(1);
  format.mockClear();
  expectLines(second.render().toString(), `# HELP ${runs} Other runs.`);
});

it("selects header help and type after gauge removal, cross-type admission, and reset", () => {
  const store = createPrometheusMetricStore();
  store.histogram(duration, "Duration.", {}, 0.5, [1]);
  expect(store.render().toString()).toContain(header(duration, "Duration.", "histogram"));
  store.gauge(duration, "Duration.", {}, 2);
  expect(store.render().toString()).toContain(header(duration, "Duration.", "gauge"));
  store.clearGauges(duration);
  expect(store.render().toString()).toContain(header(duration, "Duration.", "histogram"));
  store.counter(duration, "Duration.", {}, 3);
  expect(store.render().toString()).toContain(header(duration, "Duration.", "counter"));
  store.reset();
  store.gauge(duration, "Restarted duration.", {}, 4);
  expect(store.render().toString()).toBe(
    header(duration, "Restarted duration.", "gauge") + `${duration} 4\n`,
  );
});

it("keeps earlier scrape bytes stable across value changes, gauge removal, and reset", () => {
  const store = createPrometheusMetricStore();
  const labels = { z: '雪"\\\n', a: "first", le: "replaced" };
  const escaped = 'z="雪\\"\\\\\\n"';
  const bucket = (le: number) => `${duration}_bucket{a="first",le="${le}",${escaped}}`;
  const suffix = `{a="first",le="replaced",${escaped}}`;
  const buckets = [1, 10];
  const upperBucket = vi.fn(() => 10);
  store.histogram(duration, "Duration.", labels, 0.5, buckets);
  Object.defineProperty(buckets, 1, { get: upperBucket });
  store.counterValue(runs, "Runs.", {}, 2);
  store.gauge(depth, "Depth.", {}, 3);
  const first = store.render();
  const before = first.toString();

  store.histogram(duration, "Duration.", labels, 2, [1, 10]);
  store.counterValue(runs, "Runs.", {}, 1);
  store.counter(runs, "Runs.", {}, 4);
  store.gauge(depth, "Depth.", {}, 0);
  expectLines(
    store.render().toString(),
    `${runs} 6`,
    `${depth} 0`,
    `${bucket(1)} 1`,
    `${bucket(10)} 2`,
    `${duration}_sum${suffix} 2.5`,
  );
  for (const value of [12345, -1234, 7]) {
    store.gauge(depth, "Depth.", {}, value);
    const rendered = store.render();
    expectLines(rendered.toString(), `${depth} ${value}`);
    rendered.buffer.transfer(0);
  }
  upperBucket.mockClear();
  for (let index = 0; index < 8; index++) {
    store.histogram(duration, "Duration.", labels, 1, [1, 10]);
  }
  expect(upperBucket).not.toHaveBeenCalled();
  expectLines(
    store.render().toString(),
    `${bucket(1)} 9`,
    `${bucket(10)} 10`,
    `${duration}_count${suffix} 10`,
  );
  const largeLabel = "雪😀".repeat(1024);
  store.gauge(depth, "Depth.", { label: largeLabel }, 7);
  expectLines(store.render().toString(), `${depth}{label="${largeLabel}"} 7`);
  store.clearGauges(depth);
  expect(store.render().toString()).not.toContain(depth);
  store.reset();
  expect(first.toString()).toBe(before);
});

it("preserves label identity across property order, label shapes, and separator values", () => {
  const store = createPrometheusMetricStore();
  const labels = { a: "one", b: "two|three" };
  store.counter(runs, "Requests.", labels, 2);
  store.counter(runs, "Requests.", { b: "two|three", a: "one" }, 3);
  store.counter(runs, "Requests.", { a: "one|two", b: "three" }, 7);
  store.counter(runs, "Requests.", { a: "one" }, 11);
  store.counter(runs, "Requests.", { b: "one" }, 13);
  store.counter(runs, "Requests.", {}, 17);
  labels.a = "changed";

  expect(samples(store.render().toString(), runs).toSorted()).toEqual(
    [
      `${runs}{a="one",b="two|three"} 5`,
      `${runs}{a="one|two",b="three"} 7`,
      `${runs}{a="one"} 11`,
      `${runs}{b="one"} 13`,
      `${runs} 17`,
    ].toSorted(),
  );
});

it("bounds retained entries while reserving every family and releasing cleared gauges", () => {
  const store = createPrometheusMetricStore();
  const families = Object.keys(PROMETHEUS_FAMILY_RESERVES) as PrometheusMetricName[];
  for (const name of families) {
    for (let index = 0; index <= Math.max(128, PROMETHEUS_FAMILY_RESERVES[name]); index++) {
      store.gauge(name, "Synthetic admission pressure.", { index: String(index) }, index);
    }
  }
  const rendered = store.render().toString();
  expect(rendered).toContain(
    "# HELP openclaw_prometheus_family_series_dropped_total New-series observations dropped by bounded metric family.\n" +
      "# TYPE openclaw_prometheus_family_series_dropped_total counter\n" +
      'openclaw_prometheus_family_series_dropped_total{family="openclaw_chat_history_requests_total"} 1\n',
  );
  const admitted = rendered.split("\n").filter((line) => line.includes('{index="'));
  const count = (name: string) => admitted.filter((line) => line.startsWith(`${name}{`)).length;
  expect(admitted).toHaveLength(16384);
  for (const name of families) {
    const size = count(name);
    expect(size).toBeGreaterThanOrEqual(PROMETHEUS_FAMILY_RESERVES[name]);
    expect(size).toBeLessThanOrEqual(Math.max(128, PROMETHEUS_FAMILY_RESERVES[name]));
  }
  expect(count("openclaw_worker_request_phase_seconds")).toBe(1024);
  expect(count("openclaw_gateway_ws_event_frame_bytes")).toBe(2048);
  // This late family only used its reserve. Clearing it must not make that
  // capacity available to another family whose shared admission is exhausted.
  const late = "openclaw_worktree_preparation_seconds";
  const competing = "openclaw_webhook_received_total";
  store.clearGauges(late);
  store.counter(competing, "Competing admission.", { index: "late" });
  for (let index = 0; index < 32; index++) {
    store.gauge(late, "Rebuilt gauges.", { index: String(index) }, 2);
  }
  const rebuilt = store.render().toString();
  expect(rebuilt).not.toContain(`${competing}{index="late"}`);
  expect(samples(rebuilt, `${late}{`)).toHaveLength(32);
  expect(rebuilt.split("\n").filter((line) => line.includes('{index="'))).toHaveLength(16384);
  store.reset();
  expect(store.render().toString()).toBe("");
  for (let index = 0; index < 128; index++) {
    store.counter(late, "After reset.", { index: String(index) });
  }
  expect(samples(store.render().toString(), `${late}{`)).toHaveLength(128);
});

it("renders exact UTF-8 exposition bytes, including help, all sample kinds, and empty values", () => {
  const store = createPrometheusMetricStore();
  const labels = { label: '雪😀"\\\n', empty: "" };
  store.counter(runs, "Runs 雪\\\n.", labels, 2);
  store.gauge(depth, "Depth.", {}, -1.25);
  store.histogram(duration, "Duration.", labels, 0.5, [1]);
  const suffix = '{empty="",label="雪😀\\"\\\\\\n"}';
  const expected = [
    header(runs, "Runs 雪\\\\\\n.", "counter").trimEnd(),
    `openclaw_run_completed_total${suffix} 2`,
    header(depth, "Depth.", "gauge").trimEnd(),
    "openclaw_worker_queue_depth -1.25",
    header(duration, "Duration.", "histogram").trimEnd(),
    'openclaw_run_duration_seconds_bucket{empty="",label="雪😀\\"\\\\\\n",le="1"} 1',
    'openclaw_run_duration_seconds_bucket{empty="",label="雪😀\\"\\\\\\n",le="+Inf"} 1',
    `openclaw_run_duration_seconds_sum${suffix} 0.5`,
    `openclaw_run_duration_seconds_count${suffix} 1`,
    "",
  ].join("\n");
  expect(store.render()).toEqual(Buffer.from(expected));
});

it("does not retain unrelated pool slabs between scrapes while series stay live", async () => {
  const store = createPrometheusMetricStore();
  const churn = "x".repeat(Buffer.poolSize / 2 - 8);
  const markSeries = (index: number) => {
    // Start beyond the previous pool, which may contain unrelated live buffers.
    Buffer.from(churn);
    Buffer.from(churn);
    Buffer.from(churn);
    const before = Buffer.from("marker");
    store.gauge(depth, "Depth.", { index: String(index) }, index);
    store.render().buffer.transfer(0);
    const after = Buffer.from("marker");
    return [new WeakRef(before.buffer), new WeakRef(after.buffer)];
  };
  const references = Array.from({ length: 32 }, (_, index) => markSeries(index)).flat();
  // Move Node's current pool past all marked slabs before checking store retention.
  for (let index = 0; index < 3; index++) {
    Buffer.from(churn);
  }
  const control = new WeakRef({});
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
  expectLines(store.render().toString(), `${depth}{index="31"} 31`);
});
