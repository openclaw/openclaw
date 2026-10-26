import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import renderShape from "../benchmarks/render-shape.json" with { type: "json" };
import {
  PROMETHEUS_FAMILY_RESERVES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
import * as prometheusFormat from "./prometheus-format.js";
import { createPrometheusMetricStore } from "./prometheus-metric-store.js";

it("preserves the observed registry's golden exposition across cold and warm scrapes", () => {
  const store = createPrometheusMetricStore();
  for (const { name, labelSets, finiteBuckets } of renderShape.histograms) {
    for (let index = 0; index < labelSets; index++) {
      store.histogram(
        name as PrometheusMetricName,
        "Synthetic histogram",
        { kind: `kind-${index % 8}`, worker_slot: String(index) },
        0.005 * ((index % 17) + 1),
        finiteBuckets,
      );
    }
  }
  for (const { name, labelSets, type } of renderShape.scalars) {
    for (let index = 0; index < labelSets; index++) {
      store[type === "counter" ? "counter" : "gauge"](
        name as PrometheusMetricName,
        "Synthetic scalar",
        { kind: `kind-${index % 8}`, worker_slot: String(index) },
        index + 1,
      );
    }
  }
  // Captured from the pre-optimization owner benchmark: 4,628 series / 60,154 rows.
  for (let scrape = 0; scrape < 2; scrape++) {
    const rendered = store.render();
    expect(rendered.length).toBe(5278020);
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      "8bca72cac3d5f446991fa7c930ee2f81d56ec23d4f4afba9c4b514feb8a71cce",
    );
    rendered.buffer.transfer(0);
  }
});

it("formats unchanged family headers once across interleaved scrapes and value updates", () => {
  const first = createPrometheusMetricStore();
  const second = createPrometheusMetricStore();
  first.counter("openclaw_run_completed_total", "Runs.", { worker: "z" });
  first.gauge("openclaw_worker_queue_depth", "Runs.", {}, 1);
  first.histogram("openclaw_run_duration_seconds", "Duration.", {}, 0.5, [1]);
  second.counter("openclaw_run_completed_total", "Other runs.", {});
  const format = vi.spyOn(prometheusFormat, "escapeHelp");
  try {
    expect(first.render().toString()).toContain(
      "# HELP openclaw_worker_queue_depth Runs.\n# TYPE openclaw_worker_queue_depth gauge\n",
    );
    second.render();
    expect(format).toHaveBeenCalledTimes(4);
    format.mockClear();

    first.counter("openclaw_run_completed_total", "Ignored replacement help.", { worker: "z" });
    first.gauge("openclaw_worker_queue_depth", "Runs.", {}, 2);
    first.histogram("openclaw_run_duration_seconds", "Duration.", {}, 0.5, [1]);
    first.render();
    second.render();
    first.render();
    expect(format).not.toHaveBeenCalled();

    // A newly admitted series can sort ahead of the previous header owner.
    first.counter("openclaw_run_completed_total", "Earlier runs.\n", { worker: "a" });
    format.mockClear();
    expect(first.render().toString()).toContain(
      "# HELP openclaw_run_completed_total Earlier runs.\\n\n",
    );
    expect(format).toHaveBeenCalledTimes(1);
    format.mockClear();
    expect(second.render().toString()).toContain(
      "# HELP openclaw_run_completed_total Other runs.\n",
    );
    first.render();
    expect(format).not.toHaveBeenCalled();
  } finally {
    format.mockRestore();
  }
});

it("checks header membership once per consecutive family across warm scrapes", () => {
  const store = createPrometheusMetricStore();
  for (const worker of ["z", "a", "m"]) {
    store.counter("openclaw_run_completed_total", "Runs.", { worker });
    store.histogram("openclaw_run_duration_seconds", "Duration.", { worker }, 0.5, [1]);
  }
  store.render();
  store.counter("openclaw_run_completed_total", "Runs.", { worker: "a" });
  const membership = vi.spyOn(Set.prototype, "has");
  let checks: unknown[][];
  try {
    store.render();
    checks = membership.mock.calls.slice();
  } finally {
    membership.mockRestore();
  }
  expect(checks).toEqual([["openclaw_run_completed_total"], ["openclaw_run_duration_seconds"]]);
});

it("selects header help and type after gauge removal, cross-type admission, and reset", () => {
  const store = createPrometheusMetricStore();
  const name = "openclaw_run_duration_seconds";
  const header = (help: string, type: string) => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
  store.histogram(name, "Duration.", {}, 0.5, [1]);
  expect(store.render().toString()).toContain(header("Duration.", "histogram"));
  store.gauge(name, "Duration.", {}, 2);
  expect(store.render().toString()).toContain(header("Duration.", "gauge"));
  store.clearGauges(name);
  expect(store.render().toString()).toContain(header("Duration.", "histogram"));
  store.counter(name, "Duration.", {}, 3);
  expect(store.render().toString()).toContain(header("Duration.", "counter"));
  store.reset();
  expect(store.render().length).toBe(0);
  store.gauge(name, "Restarted duration.", {}, 4);
  expect(store.render().toString()).toBe(`${header("Restarted duration.", "gauge")}${name} 4\n`);
});

it("formats unchanged series only once across interleaved scrapes and updates", () => {
  const first = createPrometheusMetricStore();
  const second = createPrometheusMetricStore();
  first.histogram("openclaw_run_duration_seconds", "Duration.", {}, 0.015, [1]);
  second.histogram("openclaw_run_duration_seconds", "Duration.", {}, 0.025, [1]);
  first.gauge("openclaw_worker_queue_depth", "Depth.", {}, 0.125);
  const format = vi.spyOn(Number.prototype, "toPrecision");
  try {
    first.render();
    second.render();
    expect(format).toHaveBeenCalledTimes(3);
    format.mockClear();
    first.gauge("openclaw_worker_queue_depth", "Depth.", {}, 0.125);
    first.render();
    second.render();
    expect(format).not.toHaveBeenCalled();

    first.histogram("openclaw_run_duration_seconds", "Duration.", {}, 0.02, [1]);
    expect(first.render().toString()).toContain("openclaw_run_duration_seconds_sum 0.035\n");
    expect(second.render().toString()).toContain("openclaw_run_duration_seconds_sum 0.025\n");
    expect(format).toHaveBeenCalledTimes(1);
  } finally {
    format.mockRestore();
  }
});

it("keeps earlier scrape bytes stable across value changes, gauge removal, and reset", () => {
  const store = createPrometheusMetricStore();
  const labels = { z: '雪"\\\n', a: "first", le: "replaced" };
  store.histogram("openclaw_run_duration_seconds", "Duration.", labels, 0.5, [1, 10]);
  store.counterValue("openclaw_run_completed_total", "Runs.", {}, 2);
  store.gauge("openclaw_worker_queue_depth", "Depth.", {}, 3);
  const first = store.render();
  const before = first.toString();
  expect(before).toContain(
    'openclaw_run_duration_seconds_bucket{a="first",le="1",z="雪\\"\\\\\\n"} 1\n',
  );
  expect(before).toContain(
    'openclaw_run_duration_seconds_count{a="first",le="replaced",z="雪\\"\\\\\\n"} 1\n',
  );

  store.histogram("openclaw_run_duration_seconds", "Duration.", labels, 2, [1, 10]);
  store.counterValue("openclaw_run_completed_total", "Runs.", {}, 1);
  store.counter("openclaw_run_completed_total", "Runs.", {}, 4);
  store.gauge("openclaw_worker_queue_depth", "Depth.", {}, 0);
  const updated = store.render().toString();
  expect(updated).toContain("openclaw_run_completed_total 6\n");
  expect(updated).toContain("openclaw_worker_queue_depth 0\n");
  expect(updated).toContain(
    'openclaw_run_duration_seconds_bucket{a="first",le="1",z="雪\\"\\\\\\n"} 1\n',
  );
  expect(updated).toContain(
    'openclaw_run_duration_seconds_bucket{a="first",le="10",z="雪\\"\\\\\\n"} 2\n',
  );
  expect(updated).toContain(
    'openclaw_run_duration_seconds_sum{a="first",le="replaced",z="雪\\"\\\\\\n"} 2.5\n',
  );
  for (const value of [12345, -1234, 7]) {
    store.gauge("openclaw_worker_queue_depth", "Depth.", {}, value);
    const rendered = store.render();
    expect(rendered.toString()).toContain(`openclaw_worker_queue_depth ${value}\n`);
    rendered.buffer.transfer(0);
  }
  for (let index = 0; index < 8; index++) {
    store.histogram("openclaw_run_duration_seconds", "Duration.", labels, 1, [1, 10]);
  }
  expect(store.render().toString()).toContain(
    'openclaw_run_duration_seconds_count{a="first",le="replaced",z="雪\\"\\\\\\n"} 10\n',
  );
  const largeLabel = "雪😀".repeat(1024);
  store.gauge("openclaw_worker_queue_depth", "Depth.", { label: largeLabel }, 7);
  expect(store.render().toString()).toContain(
    `openclaw_worker_queue_depth{label="${largeLabel}"} 7\n`,
  );
  store.clearGauges("openclaw_worker_queue_depth");
  expect(store.render().toString()).not.toContain("openclaw_worker_queue_depth");
  store.reset();
  expect(store.render().length).toBe(0);
  expect(first.toString()).toBe(before);
});

it("preserves label identity across property order, label shapes, and separator values", () => {
  const store = createPrometheusMetricStore();
  const labels = { a: "one", b: "two|three" };
  store.counter("openclaw_run_completed_total", "Requests.", labels, 2);
  store.counter("openclaw_run_completed_total", "Requests.", { b: "two|three", a: "one" }, 3);
  store.counter("openclaw_run_completed_total", "Requests.", { a: "one|two", b: "three" }, 7);
  store.counter("openclaw_run_completed_total", "Requests.", { a: "one" }, 11);
  store.counter("openclaw_run_completed_total", "Requests.", { b: "one" }, 13);
  store.counter("openclaw_run_completed_total", "Requests.", {}, 17);
  labels.a = "changed";

  const samples = store
    .render()
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("openclaw_run_completed_total"));
  expect(samples).toHaveLength(5);
  expect(samples).toEqual(
    expect.arrayContaining([
      'openclaw_run_completed_total{a="one",b="two|three"} 5',
      'openclaw_run_completed_total{a="one|two",b="three"} 7',
      'openclaw_run_completed_total{a="one"} 11',
      'openclaw_run_completed_total{b="one"} 13',
      "openclaw_run_completed_total 17",
    ]),
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
  const samples = rendered.split("\n").filter((line) => line.includes('{index="'));
  expect(samples).toHaveLength(16384);
  for (const name of families) {
    const count = samples.filter((line) => line.startsWith(`${name}{`)).length;
    expect(count).toBeGreaterThanOrEqual(PROMETHEUS_FAMILY_RESERVES[name]);
    expect(count).toBeLessThanOrEqual(Math.max(128, PROMETHEUS_FAMILY_RESERVES[name]));
    if (name.startsWith("openclaw_gateway_rpc_")) {
      expect(count).toBeGreaterThanOrEqual(256);
    }
  }
  expect(
    samples.filter((line) => line.startsWith("openclaw_worker_request_phase_seconds{")),
  ).toHaveLength(1024);
  expect(
    samples.filter((line) => line.startsWith("openclaw_gateway_ws_event_frame_bytes{")),
  ).toHaveLength(2048);
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
  expect(rebuilt.split("\n").filter((line) => line.startsWith(`${late}{`))).toHaveLength(32);
  expect(rebuilt.split("\n").filter((line) => line.includes('{index="'))).toHaveLength(16384);
  store.reset();
  expect(store.render().toString()).toBe("");
  for (let index = 0; index < 128; index++) {
    store.counter(late, "After reset.", { index: String(index) });
  }
  expect(
    store
      .render()
      .toString()
      .split("\n")
      .filter((line) => line.startsWith(`${late}{`)),
  ).toHaveLength(128);
});

it("renders exact UTF-8 exposition bytes, including help, all sample kinds, and empty values", () => {
  const store = createPrometheusMetricStore();
  const labels = { label: '雪😀"\\\n', empty: "" };
  store.counter("openclaw_run_completed_total", "Runs 雪\\\n.", labels, 2);
  store.gauge("openclaw_worker_queue_depth", "Depth.", {}, -1.25);
  store.histogram("openclaw_run_duration_seconds", "Duration.", labels, 0.5, [1]);
  const suffix = '{empty="",label="雪😀\\"\\\\\\n"}';
  const expected = [
    "# HELP openclaw_run_completed_total Runs 雪\\\\\\n.",
    "# TYPE openclaw_run_completed_total counter",
    `openclaw_run_completed_total${suffix} 2`,
    "# HELP openclaw_worker_queue_depth Depth.",
    "# TYPE openclaw_worker_queue_depth gauge",
    "openclaw_worker_queue_depth -1.25",
    "# HELP openclaw_run_duration_seconds Duration.",
    "# TYPE openclaw_run_duration_seconds histogram",
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
    store.gauge("openclaw_worker_queue_depth", "Depth.", { index: String(index) }, index);
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
  expect(store.render().toString()).toContain('openclaw_worker_queue_depth{index="31"} 31\n');
});
