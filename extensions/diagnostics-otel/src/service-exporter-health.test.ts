import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createExporterHealthEventEmitter,
  createPublicExporterHealthEventEmitter,
  observeOtlpExporterHealth,
  type ExporterHealthUpdate,
} from "./service-exporter-health.js";

let events: ExporterHealthUpdate[];
const publish = (event: ExporterHealthUpdate) => events.push(event);
beforeEach(() => {
  events = [];
});

function createObservedExporter(signal: ExporterHealthUpdate["signal"]) {
  const shutdown = vi.fn(async () => {});
  const exportItems = vi.fn((_items: unknown, _callback: (result: ExportResult) => void) => {});
  const exporter = { export: exportItems, shutdown };
  observeOtlpExporterHealth(exporter, {
    signal,
    emitExporterEvent: createExporterHealthEventEmitter(publish),
  });
  return { exporter, exportItems, shutdown };
}

function expectPrivateFailure(
  signal: ExporterHealthUpdate["signal"],
  reason: ExporterHealthUpdate["reason"],
  privateMessage: string,
) {
  expect(events).toEqual([
    expect.objectContaining({
      signal,
      transport: "otlp-http-protobuf",
      status: "failure",
      reason,
      errorCategory: "TypeError",
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain(privateMessage);
}

it("coalesces matching failures without publishing recovery", () => {
  const emit = createPublicExporterHealthEventEmitter(publish);
  const base = {
    exporter: "diagnostics-otel",
    signal: "logs",
    reason: "emit_failed",
    errorCategory: "TypeError",
  } as const;

  emit({ ...base, transport: "otlp-http-protobuf", status: "failure" });
  emit({ ...base, transport: "stdout", status: "failure" });
  emit({ ...base, transport: "otlp-http-protobuf", status: "recovered" });
  emit({ ...base, transport: "stdout", status: "recovered" });
  emit({
    exporter: "diagnostics-otel",
    signal: "logs",
    transport: "stdout",
    status: "failure",
    reason: "queue_full",
  });

  expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
    { status: "failure", reason: "emit_failed" },
    { status: "failure", reason: "queue_full" },
  ]);
});

it("keeps the oldest active exporter failure visible until its producer recovers", () => {
  const emit = createExporterHealthEventEmitter(publish);
  const route = {
    exporter: "diagnostics-otel",
    signal: "logs",
    transport: "otlp-http-protobuf",
  } as const;

  emit({ ...route, status: "failure", reason: "emit_failed" });
  emit({ ...route, status: "failure", reason: "export_failed" });
  emit({ ...route, status: "recovered", reason: "export_failed" });
  emit({ ...route, status: "failure", reason: "export_failed" });
  emit({ ...route, status: "recovered", reason: "emit_failed" });
  emit({ ...route, status: "recovered", reason: "export_failed" });

  expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
    { status: "failure", reason: "emit_failed" },
    { status: "failure", reason: "export_failed" },
    { status: "recovered", reason: "export_failed" },
  ]);
});

it("records and rethrows a synchronous dependency export failure once", () => {
  const { exporter, exportItems } = createObservedExporter("logs");
  exportItems.mockImplementation(() => {
    throw new TypeError("private serialization details");
  });

  expect(() => exporter.export([], vi.fn())).toThrow("private serialization details");
  expect(() => exporter.export([], vi.fn())).toThrow("private serialization details");
  expectPrivateFailure("logs", "export_failed", "private serialization details");
});

it("does not misclassify a synchronous consumer callback failure", () => {
  const { exporter, exportItems } = createObservedExporter("metrics");
  exportItems.mockImplementation((_items, callback) => {
    callback({ code: ExportResultCode.SUCCESS });
  });

  expect(() =>
    exporter.export([], () => {
      throw new Error("consumer callback failed");
    }),
  ).toThrow("consumer callback failed");
  expect(events).toEqual([]);
});
