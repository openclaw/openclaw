import { installReportFixtureTransport } from "./report-fixture-transport.test-support.js";

installReportFixtureTransport(
  "./report-run.benchmark-fixtures.test-support.ts",
  "Benchmark attempted a real network request",
);

await import("./run.worker.js");
