// Plugin families recorded through api.metrics share the exporter's store and series budget.
import { describe, expect, it, vi } from "vitest";
import type { PluginMetricFamily } from "../api.js";
import { MAX_PROMETHEUS_FAMILY_SERIES } from "./prometheus-family-budget.js";
import { createMetricsHarness, expectMetrics } from "./service.test-helpers.js";

// Scrapes here come from an authorized operator; the scope guard has its own test.
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: { connect: { scopes: ["operator.read"] } },
  }),
}));

const retain: PluginMetricFamily = {
  name: "openclaw_plugin_my_plugin_retain_total",
  type: "counter",
  help: "Retains by outcome",
  labels: ["outcome"],
};
const recall: PluginMetricFamily = {
  name: "openclaw_plugin_my_plugin_recall_seconds",
  type: "histogram",
  help: "Recall latency",
  labels: [],
  buckets: [0.1, 1],
};
const queue: PluginMetricFamily = {
  name: "openclaw_plugin_my_plugin_queue_depth",
  type: "gauge",
  help: "Queued jobs",
  labels: ["queue"],
};

describe("diagnostics-prometheus plugin metric families", () => {
  it("serves plugin counters, gauges and histograms from the scrape route", () => {
    using metrics = createMetricsHarness();
    metrics.recordPlugin(retain, { outcome: "ok" }, 1);
    metrics.recordPlugin(retain, { outcome: "ok" }, 2);
    metrics.recordPlugin(queue, { queue: "main" }, 4);
    metrics.recordPlugin(queue, { queue: "main" }, 3);
    metrics.recordPlugin(recall, {}, 0.12);
    expectMetrics(
      metrics.render(),
    )(`# HELP openclaw_plugin_my_plugin_retain_total Retains by outcome
# TYPE openclaw_plugin_my_plugin_retain_total counter
openclaw_plugin_my_plugin_retain_total{outcome="ok"} 3
# TYPE openclaw_plugin_my_plugin_queue_depth gauge
openclaw_plugin_my_plugin_queue_depth{queue="main"} 3
# TYPE openclaw_plugin_my_plugin_recall_seconds histogram
openclaw_plugin_my_plugin_recall_seconds_bucket{le="0.1"} 0
openclaw_plugin_my_plugin_recall_seconds_bucket{le="1"} 1
openclaw_plugin_my_plugin_recall_seconds_bucket{le="+Inf"} 1
openclaw_plugin_my_plugin_recall_seconds_sum 0.12
openclaw_plugin_my_plugin_recall_seconds_count 1`);
  });

  it("caps each plugin family at the shared per-family series limit and counts drops", () => {
    using metrics = createMetricsHarness();
    for (let index = 0; index < MAX_PROMETHEUS_FAMILY_SERIES + 5; index++) {
      metrics.recordPlugin(queue, { queue: `q${index}` }, 1);
    }
    const body = metrics.render();
    const admitted = body
      .split("\n")
      .filter((line) => line.startsWith("openclaw_plugin_my_plugin_queue_depth{"));
    expect(admitted).toHaveLength(MAX_PROMETHEUS_FAMILY_SERIES);
    expect(body).toContain(
      'openclaw_prometheus_family_series_dropped_total{family="openclaw_plugin_my_plugin_queue_depth"} 5',
    );
  });

  it("drops retired families so a re-registered name renders one TYPE block", () => {
    using metrics = createMetricsHarness();
    const depth: PluginMetricFamily = {
      ...queue,
      name: "openclaw_plugin_my_plugin_depth",
      labels: [],
    };
    const jobsGauge: PluginMetricFamily = { ...retain, type: "gauge", labels: [] };
    metrics.recordPlugin(depth, {}, 7);
    metrics.recordPlugin(jobsGauge, {}, 4);
    metrics.retirePlugin([depth.name, jobsGauge.name]);
    metrics.recordPlugin({ ...retain, labels: [] }, {}, 1);
    const lines = metrics.render().split("\n");
    expect(lines.filter((line) => line.includes("openclaw_plugin_my_plugin_"))).toEqual([
      "# HELP openclaw_plugin_my_plugin_retain_total Retains by outcome",
      "# TYPE openclaw_plugin_my_plugin_retain_total counter",
      "openclaw_plugin_my_plugin_retain_total 1",
    ]);
  });

  it("releases a retired family's series budget", () => {
    using metrics = createMetricsHarness();
    for (let index = 0; index < MAX_PROMETHEUS_FAMILY_SERIES; index++) {
      metrics.recordPlugin(queue, { queue: `q${index}` }, 1);
    }
    metrics.retirePlugin([queue.name]);
    metrics.recordPlugin(queue, { queue: "fresh" }, 1);
    const body = metrics.render();
    expect(body).toContain('openclaw_plugin_my_plugin_queue_depth{queue="fresh"} 1');
    expect(body).not.toContain('queue="q0"');
    expect(body).not.toContain("openclaw_prometheus_family_series_dropped_total");
  });

  it("stops serving plugin samples when the exporter stops", () => {
    using metrics = createMetricsHarness();
    metrics.recordPlugin(retain, { outcome: "ok" }, 1);
    metrics.stop();
    metrics.start();
    expect(metrics.render()).not.toContain("openclaw_plugin_my_plugin_retain_total");
  });
});
