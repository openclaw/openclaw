import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

function cpuTimes() {
  return os.cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0),
    }),
    { idle: 0, total: 0 },
  );
}

// bootstatus finishes before first-launch services settle. Reserve room for the
// Gateway and XCTest without extending either one's request or test deadlines.
export async function waitForIOSSimulatorHeadroom(signal: AbortSignal) {
  const started = performance.now();
  const deadline = started + 300_000;
  let previousAt = started;
  let previous = cpuTimes();
  let healthyMs = 0;
  let samples = 0;
  let idlePercent: number | undefined;
  while (performance.now() < deadline) {
    await sleep(Math.min(2_000, deadline - performance.now()), undefined, { signal });
    const now = performance.now();
    const current = cpuTimes();
    const intervalMs = now - previousAt;
    const total = current.total - previous.total;
    idlePercent = total > 0 ? (100 * (current.idle - previous.idle)) / total : undefined;
    // A delayed observer cannot establish continuous headroom from a long average.
    healthyMs =
      idlePercent !== undefined && idlePercent >= 30 && intervalMs <= 4_000
        ? healthyMs + intervalMs
        : 0;
    samples++;
    if (healthyMs >= 10_000) {
      return {
        status: "ready" as const,
        elapsedMs: Math.round(now - started),
        samples,
        idlePercent,
      };
    }
    previous = current;
    previousAt = now;
  }
  return {
    status: "timeout" as const,
    elapsedMs: Math.round(performance.now() - started),
    samples,
    idlePercent,
  };
}
