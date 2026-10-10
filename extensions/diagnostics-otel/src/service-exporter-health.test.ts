import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { describe, expect, it, vi } from "vitest";
import {
  createExporterHealthEventEmitter,
  createPublicExporterHealthEventEmitter,
  observeOtlpExporterHealth,
  type ExporterHealthUpdate,
} from "./service-exporter-health.js";

function createObservedExporter(events: ExporterHealthUpdate[]) {
  const shutdown = vi.fn(async () => {});
  const exporter = {
    export: vi.fn((_items: unknown, _callback: (result: ExportResult) => void) => {}),
    shutdown,
  };
  observeOtlpExporterHealth(exporter, {
    signal: "traces",
    emitExporterEvent: createExporterHealthEventEmitter((event) => {
      events.push(event);
    }),
  });
  return {
    exporter,
    shutdown,
  };
}

describe("createPublicExporterHealthEventEmitter", () => {
  it("coalesces matching failures without publishing recovery", () => {
    const events: ExporterHealthUpdate[] = [];
    const emit = createPublicExporterHealthEventEmitter((event) => events.push(event));
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
});

describe("observeOtlpExporterHealth", () => {
  it("records a shutdown rejection without exposing its message", async () => {
    const events: ExporterHealthUpdate[] = [];
    const observed = createObservedExporter(events);
    observed.shutdown.mockRejectedValueOnce(new TypeError("private collector details"));

    await expect(observed.exporter.shutdown()).rejects.toThrow("private collector details");
    expect(events).toEqual([
      expect.objectContaining({
        signal: "traces",
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "shutdown_failed",
        errorCategory: "TypeError",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private collector details");
  });

  it("records and rethrows a synchronous dependency export failure once", () => {
    const events: ExporterHealthUpdate[] = [];
    const exportItems = vi.fn((_items: unknown, _callback: (result: ExportResult) => void) => {
      throw new TypeError("private serialization details");
    });
    const exporter = {
      export: exportItems,
      shutdown: vi.fn(async () => {}),
    };
    observeOtlpExporterHealth(exporter, {
      signal: "logs",
      emitExporterEvent: createExporterHealthEventEmitter((event) => {
        events.push(event);
      }),
    });

    expect(() => exporter.export([], vi.fn())).toThrow("private serialization details");
    expect(() => exporter.export([], vi.fn())).toThrow("private serialization details");
    expect(events).toEqual([
      expect.objectContaining({
        signal: "logs",
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "export_failed",
        errorCategory: "TypeError",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private serialization details");
  });

  it("does not misclassify a synchronous consumer callback failure", () => {
    const events: ExporterHealthUpdate[] = [];
    const exporter = {
      export: vi.fn((_items: unknown, callback: (result: ExportResult) => void) => {
        callback({ code: ExportResultCode.SUCCESS });
      }),
      shutdown: vi.fn(async () => {}),
    };
    observeOtlpExporterHealth(exporter, {
      signal: "metrics",
      emitExporterEvent: createExporterHealthEventEmitter((event) => {
        events.push(event);
      }),
    });

    expect(() =>
      exporter.export([], () => {
        throw new Error("consumer callback failed");
      }),
    ).toThrow("consumer callback failed");
    expect(events).toEqual([]);
  });
});
