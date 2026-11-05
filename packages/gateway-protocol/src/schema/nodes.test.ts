import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  NodeInvokeCancelEventSchema,
  type NodeInvokeCancelEvent,
  validateNodeHostStatsPayload,
  validateNodeInvokeProgressParams,
} from "../index.js";
import { ProtocolSchemas } from "./protocol-schemas.js";

function stats(
  cpuCount: number,
  loadAverage: number[],
  [memoryTotalBytes, memoryFreeBytes]: [number, number],
  [diskTotalBytes, diskAvailableBytes]: [number, number],
) {
  return {
    cpuCount,
    loadAverage,
    memoryTotalBytes,
    memoryFreeBytes,
    diskTotalBytes,
    diskAvailableBytes,
  };
}

describe("node protocol schemas", () => {
  const minimalStats = { cpuCount: 1, memoryTotalBytes: 0, memoryFreeBytes: 0 };

  it("publishes the closed node invoke cancellation payload", () => {
    const payload: NodeInvokeCancelEvent = { invokeId: "invoke-1", nodeId: "node-1" };

    expect(ProtocolSchemas.NodeInvokeCancelEvent).toBe(NodeInvokeCancelEventSchema);
    expect(Value.Check(NodeInvokeCancelEventSchema, payload)).toBe(true);
    expect(Value.Check(NodeInvokeCancelEventSchema, { ...payload, invokeId: "" })).toBe(false);
    expect(Value.Check(NodeInvokeCancelEventSchema, { invokeId: "invoke-1" })).toBe(false);
    expect(Value.Check(NodeInvokeCancelEventSchema, { ...payload, extra: true })).toBe(false);
  });

  it.each([
    ["minimal", minimalStats],
    ["full", stats(16, [1.5, 2, 0.75], [16_000, 4_000], [100_000, 25_000])],
    ["upper bounds and equal capacities", stats(4_096, [100_000, 0, 100_000], [100, 100], [0, 0])],
  ])("accepts %s host stats", (_name, payload) => {
    expect(validateNodeHostStatsPayload(payload)).toBe(true);
  });

  it.each([
    ["extra fields", { extra: true }],
    ["node-provided timestamps", { updatedAtMs: 1_000 }],
    ["zero CPUs", { cpuCount: 0 }],
    ["too many CPUs", { cpuCount: 4_097 }],
    ["fractional CPUs", { cpuCount: 1.5 }],
    ["negative memory total", { memoryTotalBytes: -1 }],
    ["negative free memory", { memoryFreeBytes: -1 }],
    ["fractional memory bytes", { memoryTotalBytes: 1.5 }],
    ["free memory above total", { memoryFreeBytes: 1 }],
    ["disk total alone", { diskTotalBytes: 10 }],
    ["disk available alone", { diskAvailableBytes: 10 }],
    ["negative disk total", { diskTotalBytes: -1, diskAvailableBytes: 0 }],
    ["negative disk available", { diskTotalBytes: 10, diskAvailableBytes: -1 }],
    ["fractional disk bytes", { diskTotalBytes: 10, diskAvailableBytes: 1.5 }],
    ["available disk above total", { diskTotalBytes: 10, diskAvailableBytes: 11 }],
    ["two load averages", { loadAverage: [1, 2] }],
    ["four load averages", { loadAverage: [1, 2, 3, 4] }],
    ["negative load average", { loadAverage: [0, -1, 0] }],
    ["excessive load average", { loadAverage: [0, 0, 100_001] }],
    ["infinite load average", { loadAverage: [Infinity, 0, 0] }],
    ["NaN load average", { loadAverage: [0, Number.NaN, 0] }],
  ])("rejects host stats with %s", (_name, overrides) => {
    expect(validateNodeHostStatsPayload({ ...minimalStats, ...overrides })).toBe(false);
  });

  it("accepts bounded progress chunks and rejects extra fields", () => {
    const progress = { invokeId: "invoke-1", nodeId: "node-1", seq: 0, chunk: "stdout line" };
    expect(validateNodeInvokeProgressParams(progress)).toBe(true);
    expect(
      validateNodeInvokeProgressParams({ ...progress, chunk: "x".repeat(16 * 1024 + 1) }),
    ).toBe(false);
    expect(validateNodeInvokeProgressParams({ ...progress, extra: "not allowed" })).toBe(false);
  });
});
