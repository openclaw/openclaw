import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { createRuntimeImportGraph } from "../../../../scripts/lib/runtime-import-closure.mts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const entry = "src/agents/sessions/tools/write.ts";
const graph = createRuntimeImportGraph(repoRoot, [entry], { sourceImports: true });
afterAll(() => graph.close());

it("keeps worker-owned diff computation out of the write tool's static import graph", () => {
  const files = new Set([entry]);
  const eagerDiffImports: string[] = [];
  for (const file of files) {
    for (const { specifier, resolvedFileName } of graph.dependencies(file)) {
      if (specifier === "diff") {
        eagerDiffImports.push(file);
      }
      if (specifier.startsWith(".") && resolvedFileName) {
        files.add(path.relative(repoRoot, resolvedFileName));
      }
    }
  }
  expect(eagerDiffImports).toEqual([]);
});
