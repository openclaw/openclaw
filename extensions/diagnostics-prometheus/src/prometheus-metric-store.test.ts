import { expect, it } from "vitest";
import {
  PROMETHEUS_FAMILY_RESERVES,
  type PrometheusMetricName,
} from "./prometheus-family-budget.js";
import { createPrometheusMetricStore } from "./prometheus-metric-store.js";

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
    for (let index = 0; index < 400; index++) {
      store.gauge(name, "Synthetic admission pressure.", { index: String(index) }, index);
    }
  }
  const samples = store
    .render()
    .split("\n")
    .filter((line) => line.includes('{index="'));
  expect(samples).toHaveLength(2048);
  for (const name of families) {
    const count = samples.filter((line) => line.startsWith(`${name}{`)).length;
    expect(count).toBeGreaterThanOrEqual(PROMETHEUS_FAMILY_RESERVES[name]);
    expect(count).toBeLessThanOrEqual(Math.max(128, PROMETHEUS_FAMILY_RESERVES[name]));
  }
  expect(
    samples.filter((line) => line.startsWith("openclaw_worker_request_phase_seconds{")),
  ).toHaveLength(384);
  expect(
    samples.filter((line) => line.startsWith("openclaw_gateway_ws_event_frame_bytes{")),
  ).toHaveLength(256);
  // This late family only used its reserve. Clearing it must not make that
  // capacity available to another family whose shared admission is exhausted.
  const late = "openclaw_worktree_preparation_seconds";
  const competing = "openclaw_worker_request_seconds";
  store.clearGauges(late);
  store.counter(competing, "Competing admission.", { index: "late" });
  for (let index = 0; index < 32; index++) {
    store.gauge(late, "Rebuilt gauges.", { index: String(index) }, 2);
  }
  const rebuilt = store.render();
  expect(rebuilt).not.toContain(`${competing}{index="late"}`);
  expect(rebuilt.split("\n").filter((line) => line.startsWith(`${late}{`))).toHaveLength(32);
  expect(rebuilt.split("\n").filter((line) => line.includes('{index="'))).toHaveLength(2048);
  store.reset();
  expect(store.render()).toBe("");
  for (let index = 0; index < 128; index++) {
    store.counter(late, "After reset.", { index: String(index) });
  }
  expect(
    store
      .render()
      .split("\n")
      .filter((line) => line.startsWith(`${late}{`)),
  ).toHaveLength(128);
});
