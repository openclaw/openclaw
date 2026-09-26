import { performance } from "node:perf_hooks";

/** Timer drift also captures work that blocks before the native histogram's first poll. */
export function startBenchmarkIntervalDelay(): () => number[] {
  const intervalMs = 10;
  const samples: number[] = [];
  let previousTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - previousTick - intervalMs));
    previousTick = now;
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    return samples;
  };
}
