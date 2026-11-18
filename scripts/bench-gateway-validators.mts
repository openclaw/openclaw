import { performance } from "node:perf_hooks";
import { Settings } from "typebox/system";
import {
  validateNodeHostStatsPayload,
  validateRequestFrame,
} from "../packages/gateway-protocol/src/validator-registry.js";

// Compare the same entry on the base and candidate, with five interleaved process
// samples. Keep first-check setup separate from warm checks; report medians/p95.
// Acceptance: identical positive/negative controls, no runtime compiler in the
// candidate, lower AOT check cost, and no unexplained >20% plain-runtime regression.
// --walker reproduces the standalone builder's existing TypeBox fallback policy.
if (process.argv.includes("--walker")) {
  Settings.Set({ useAcceleration: false });
}

type Scenario = {
  name: string;
  validate: (value: unknown) => boolean;
  accepted: readonly unknown[];
  rejected: readonly unknown[];
};

const scenarios: Scenario[] = [
  {
    name: "request-frame",
    validate: validateRequestFrame,
    accepted: Array.from({ length: 8 }, (_, index) => ({
      type: "req",
      id: `request-${index}`,
      method: "health",
      params: { sample: index },
    })),
    rejected: [
      { type: "req", id: 42, method: "health" },
      { type: "req", id: "r", method: "" },
    ],
  },
  {
    name: "node-host-stats",
    validate: validateNodeHostStatsPayload,
    accepted: Array.from({ length: 8 }, (_, index) => ({
      cpuCount: 4,
      memoryTotalBytes: 1024,
      memoryFreeBytes: 128 * index,
      diskTotalBytes: 2048,
      diskAvailableBytes: 256 * index,
    })),
    rejected: [
      { cpuCount: 4, memoryTotalBytes: 1024, memoryFreeBytes: 1025 },
      { cpuCount: 4, memoryTotalBytes: 1024, memoryFreeBytes: 512, diskAvailableBytes: 1 },
    ],
  },
];

const iterations = 100_000;
const output = scenarios.map(({ name, validate, accepted, rejected }) => {
  const firstStart = performance.now();
  if (!validate(accepted[0])) {
    throw new Error(`${name}: accepted first-check fixture rejected`);
  }
  const firstCheckMs = performance.now() - firstStart;
  for (const value of accepted) {
    if (!validate(value)) {
      throw new Error(`${name}: accepted fixture rejected`);
    }
  }
  for (const value of rejected) {
    if (validate(value)) {
      throw new Error(`${name}: rejected fixture accepted`);
    }
  }
  let checksum = 0;
  for (let index = 0; index < 20_000; index++) {
    checksum += Number(validate(accepted[index % accepted.length]));
  }
  const samples = Array.from({ length: 5 }, () => {
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    for (let index = 0; index < iterations; index++) {
      checksum += Number(validate(accepted[index % accepted.length]));
    }
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    return {
      wallNsPerCheck: (wallMs * 1_000_000) / iterations,
      cpuNsPerCheck: ((cpu.user + cpu.system) * 1000) / iterations,
    };
  });
  if (checksum !== 520_000) {
    throw new Error(`${name}: checksum changed during warm validation`);
  }
  return { name, firstCheckMs, iterations, checksum, samples };
});

console.log(
  JSON.stringify({ mode: process.argv.includes("--walker") ? "walker" : "default", output }),
);
