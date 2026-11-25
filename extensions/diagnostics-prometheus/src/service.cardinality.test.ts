import { expect, it, vi } from "vitest";
import { cardinalityEvents } from "./label-cardinality.test-support.js";
import { createMetricsHarness } from "./service.test-helpers.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getPluginRuntimeGatewayRequestScope: () => ({
    client: { connect: { scopes: ["operator.read"] } },
  }),
}));

it("keeps queue labels closed across distinct sessions, jobs and custom lanes", () => {
  using metrics = createMetricsHarness();
  for (const event of cardinalityEvents(1000)) {
    if (event.type !== "gateway.rpc") {
      metrics.record(event);
    }
  }
  const body = metrics.render();
  const sizes = body.split("\n").filter((line) => line.startsWith("openclaw_queue_lane_size{"));
  expect(new Set(sizes.map((line) => line.match(/lane="([^"]+)"/)?.[1]))).toEqual(
    new Set(["background", "cron", "dreaming-narrative", "session", "subagent", "unknown"]),
  );
  expect(sizes.every((line) => line.endsWith(" 0"))).toBe(true);
  const waits = body
    .split("\n")
    .filter((line) => line.startsWith("openclaw_queue_lane_wait_seconds_count{"));
  expect(waits).toHaveLength(6);
  expect(waits.every((line) => line.endsWith(" 1000"))).toBe(true);
  expect(body).not.toContain("openclaw_prometheus_series_dropped_total");
});

it("counts every model and cron request shape within the unchanged family budgets", () => {
  using metrics = createMetricsHarness();
  for (const event of cardinalityEvents(0)) {
    metrics.record(event);
  }
  const body = metrics.render();
  for (const [family, series, total] of [
    ["models", 40, 960],
    ["cron", 24, 144],
  ] as const) {
    const lines = body
      .split("\n")
      .filter((line) => line.startsWith(`openclaw_${family}_list_requests_total{`));
    expect(lines).toHaveLength(series);
    expect(lines.reduce((sum, line) => sum + Number(line.split(" ").at(-1)), 0)).toBe(total);
  }
  expect(body).not.toContain("openclaw_prometheus_series_dropped_total");
});
