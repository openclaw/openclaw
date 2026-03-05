#!/usr/bin/env tsx
/**
 * Run performance benchmarks
 */

import { performance } from "perf_hooks";

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof COLORS = "reset") {
  console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
}

function benchmark(
  name: string,
  fn: () => void,
  iterations: number = 1000,
): BenchmarkResult {
  const times: number[] = [];

  // Warm up
  for (let i = 0; i < 10; i++) {
    fn();
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  const totalTime = times.reduce((sum, t) => sum + t, 0);
  const avgTime = totalTime / iterations;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);

  return {
    name,
    iterations,
    totalTime,
    avgTime,
    minTime,
    maxTime,
  };
}

function printResults(results: BenchmarkResult[]) {
  log("\n  Benchmark                 Avg Time    Min Time    Max Time", "cyan");
  log("  " + "─".repeat(70), "cyan");

  results.forEach(({ name, avgTime, minTime, maxTime }) => {
    const avg = `${avgTime.toFixed(3)}ms`.padStart(10);
    const min = `${minTime.toFixed(3)}ms`.padStart(10);
    const max = `${maxTime.toFixed(3)}ms`.padStart(10);

    log(`  ${name.padEnd(25)} ${avg}  ${min}  ${max}`, "reset");
  });
}

log("⚡ Performance Benchmarks", "blue");
log("=".repeat(70), "blue");

// Example benchmarks
const results: BenchmarkResult[] = [];

// Benchmark 1: Array operations
results.push(
  benchmark(
    "Array.map (1000 items)",
    () => {
      const arr = Array.from({ length: 1000 }, (_, i) => i);
      arr.map((x) => x * 2);
    },
    1000,
  ),
);

// Benchmark 2: Object creation
results.push(
  benchmark(
    "Object creation",
    () => {
      const obj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
      return obj;
    },
    10000,
  ),
);

// Benchmark 3: String concatenation
results.push(
  benchmark(
    "String concatenation",
    () => {
      let str = "";
      for (let i = 0; i < 100; i++) {
        str += "a";
      }
      return str;
    },
    1000,
  ),
);

printResults(results);

log("\n" + "=".repeat(70), "blue");
log("✓ Benchmarks complete", "green");
log("\n💡 Tip: Add custom benchmarks for your specific use cases", "cyan");
