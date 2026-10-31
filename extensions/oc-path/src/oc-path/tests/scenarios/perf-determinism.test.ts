import { describe, expect, it } from "vitest";
import { parseMd } from "../../parse.js";
import { resolveMdOcPath as resolveOcPath } from "../../resolve.js";

const cpuBudgetMultiplier = process.env.CI ? 4 : 1;

function expectWithinCpuBudget(run: () => void, localCpuBudgetMs: number) {
  // Budget this worker's synchronous compute, excluding off-CPU waits and CPU
  // consumed by other Vitest workers in the same process.
  const start = process.threadCpuUsage();
  run();
  const { user, system } = process.threadCpuUsage(start);
  expect((user + system) / 1000).toBeLessThan(localCpuBudgetMs * cpuBudgetMultiplier);
}

describe("CPU budgets + determinism", () => {
  it("does not charge off-CPU waits to the synchronous work budget", () => {
    const waitState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    expectWithinCpuBudget(() => {
      Atomics.wait(waitState, 0, 0, 250);
    }, 50);
  });

  it("resolves 100k OcPaths on parsed AST within a 500 ms CPU budget", () => {
    const raw = `## A\n- a1\n- a2\n## B\n- b1\n- b2\n## C\n- c1: cv\n`;
    const ast = parseMd(raw);
    const path = { file: "X.md", section: "b", item: "b1" };
    expectWithinCpuBudget(() => {
      for (let i = 0; i < 100_000; i++) {
        resolveOcPath(ast, path);
      }
    }, 500);
  });

  it("resolveOcPath is non-mutating", () => {
    const raw = `## A\n- a: x\n## B\n- b\n`;
    const ast = parseMd(raw);
    const before = JSON.stringify(ast);
    resolveOcPath(ast, { file: "X.md", section: "a", item: "a", field: "a" });
    resolveOcPath(ast, { file: "X.md", section: "b" });
    resolveOcPath(ast, { file: "X.md", section: "unknown" });
    expect(JSON.stringify(ast)).toBe(before);
  });
});
