import { expect, it } from "vitest";
import {
  PROMETHEUS_FAMILY_RESERVES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
import { createPrometheusMetricStore } from "./prometheus-metric-store.js";

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
  const samples = store
    .render()
    .toString()
    .split("\n")
    .filter((line) => line.includes('{index="'));
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
