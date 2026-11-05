import { installReportFixtureTransport } from "./report-fixture-transport.test-support.js";

installReportFixtureTransport(
  "./run-worker.collection-fixtures.test-support.ts",
  "Report fixture attempted a real network request",
);

await import("./run.worker.js");
