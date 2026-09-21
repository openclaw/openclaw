import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GatewayEventLoopHealthSchema } from "./runtime-vitals.js";

const health = {
  degraded: false,
  reasons: [],
  intervalMs: 1_000,
  delayP99Ms: 20,
  delayMaxMs: 20,
  utilization: 0.1,
  cpuCoreRatio: 2.5,
};

describe("CPU breakdown wire contract", () => {
  it.each([
    undefined,
    {},
    { hostUtilization: 0.5, hostCpuCount: 8 },
    { mainThreadCoreRatio: 0.5, workerCoreRatio: 1.5, otherThreadsCoreRatio: 0.5 },
    {
      mainThreadCoreRatio: 0,
      workerCoreRatio: 0,
      otherThreadsCoreRatio: 0,
      hostUtilization: 0,
      hostCpuCount: 1,
    },
  ])("accepts additive and independently unavailable counters: %j", (cpuBreakdown) => {
    expect(Value.Check(GatewayEventLoopHealthSchema, { ...health, cpuBreakdown })).toBe(true);
  });

  it.each([
    { hostUtilization: 1.01 },
    { hostUtilization: -0.1 },
    { hostCpuCount: 0 },
    { hostCpuCount: 1.5 },
    { mainThreadCoreRatio: -1 },
    { workerCoreRatio: -1 },
    { otherThreadsCoreRatio: -1 },
    { workerCoreRatio: "0" },
    { hostUtilization: null },
    { unknownCounter: 1 },
  ])("rejects invalid counter units or shapes: %j", (cpuBreakdown) => {
    expect(Value.Check(GatewayEventLoopHealthSchema, { ...health, cpuBreakdown })).toBe(false);
  });
});
