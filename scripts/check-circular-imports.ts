/**
 * Detect circular import chains in TypeScript source files.
 *
 * Reports only minimal cycles (no proper subset is itself a cycle) to avoid
 * combinatorial explosion of longer paths through the same core loops.
 *
 * Usage:
 *   node --import tsx scripts/check-circular-imports.ts [--root src] [--max 50]
 *
 * Exits 0 when cycle count is within the --max threshold, 1 otherwise.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type ParsedArgs = {
  roots: string[];
  maxCycles: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const roots: string[] = [];
  let maxCycles = 0; // 0 = no tolerance (fail on any cycle)

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--root") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("Missing --root value");
      }
      roots.push(next);
      index++;
    } else if (arg === "--max") {
      const next = argv[index + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("Missing/invalid --max value");
      }
      maxCycles = Number(next);
      index++;
    }
  }

  if (roots.length === 0) {
    roots.push("src");
  }
  return { roots, maxCycles };
}

function gitLsFiles(roots: string[]): string[] {
  const stdout = execFileSync("git", ["ls-files", "--cached", "--exclude-standard", ...roots], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const IMPORT_REGEX = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const REEXPORT_REGEX = /(?:^|\n)\s*export\s+(?:\*|{[^}]*})\s+from\s+['"]([^'"]+)['"]/g;

function extractImports(content: string): string[] {
  const specifiers: string[] = [];
  for (const match of content.matchAll(IMPORT_REGEX)) {
    specifiers.push(match[1]);
  }
  for (const match of content.matchAll(REEXPORT_REGEX)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, specifier);

  // Strip .js/.jsx extension (common in ESM TypeScript)
  if (resolved.endsWith(".js")) {
    resolved = resolved.slice(0, -3);
  } else if (resolved.endsWith(".jsx")) {
    resolved = resolved.slice(0, -4);
  }

  for (const ext of ["", ...EXTENSIONS]) {
    const candidate = resolved + ext;
    if (existsSync(candidate)) {
      return path.relative(process.cwd(), candidate);
    }
  }

  for (const ext of EXTENSIONS) {
    const candidate = path.join(resolved, `index${ext}`);
    if (existsSync(candidate)) {
      return path.relative(process.cwd(), candidate);
    }
  }

  return null;
}

type Graph = Map<string, Set<string>>;

function buildDependencyGraph(files: string[]): Graph {
  const graph: Graph = new Map();
  const tsFiles = new Set(files);

  for (const filePath of files) {
    if (!existsSync(filePath)) {
      continue;
    }
    const content = readFileSync(filePath, "utf8");
    const imports = extractImports(content);
    const deps = new Set<string>();

    for (const specifier of imports) {
      const resolved = resolveImport(filePath, specifier);
      if (resolved && tsFiles.has(resolved)) {
        deps.add(resolved);
      }
    }

    graph.set(filePath, deps);
  }

  return graph;
}

/**
 * Find all minimal cycles using Johnson's algorithm (simplified).
 * A minimal cycle has no shortcut — removing any edge breaks it.
 */
function findMinimalCycles(graph: Graph): string[][] {
  // Use Tarjan's SCC algorithm to find strongly connected components,
  // then extract elementary cycles within each SCC.
  const nodes = [...graph.keys()];
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;
  const sccs: string[][] = [];

  function strongconnect(v: string) {
    index.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const v of nodes) {
    if (!index.has(v)) {
      strongconnect(v);
    }
  }

  // For each SCC, find direct back-edges (shortest cycles)
  const cycles: string[][] = [];
  for (const scc of sccs) {
    const sccSet = new Set(scc);

    // Find all 2-node cycles (A→B→A)
    for (const a of scc) {
      for (const b of graph.get(a) ?? []) {
        if (sccSet.has(b) && b > a && (graph.get(b) ?? new Set()).has(a)) {
          cycles.push([a, b]);
        }
      }
    }

    // Find all 3-node cycles not covered by 2-node ones
    const twoNodePairs = new Set<string>();
    for (const cycle of cycles) {
      if (cycle.length === 2) {
        twoNodePairs.add(`${cycle[0]}|${cycle[1]}`);
        twoNodePairs.add(`${cycle[1]}|${cycle[0]}`);
      }
    }

    for (const a of scc) {
      for (const b of graph.get(a) ?? []) {
        if (!sccSet.has(b)) {
          continue;
        }
        for (const c of graph.get(b) ?? []) {
          if (!sccSet.has(c) || c === a || c === b) {
            continue;
          }
          if ((graph.get(c) ?? new Set()).has(a)) {
            const sorted = [a, b, c].toSorted();
            const key = sorted.join("|");
            if (!twoNodePairs.has(`${a}|${b}`) || !twoNodePairs.has(`${b}|${c}`)) {
              cycles.push([a, b, c]);
            }
            // Deduplicate
            twoNodePairs.add(key);
          }
        }
      }
    }
  }

  return deduplicateCycles(cycles);
}

function deduplicateCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];

  for (const cycle of cycles) {
    const sorted = [...cycle].toSorted();
    const minIdx = cycle.indexOf(sorted[0]);
    const normalized = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
    const key = normalized.join(" -> ");
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(normalized);
    }
  }

  return unique.toSorted((a, b) => a.length - b.length || a[0].localeCompare(b[0]));
}

async function main() {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });

  const { roots, maxCycles } = parseArgs(process.argv.slice(2));
  const files = gitLsFiles(roots).filter(
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".tsx")) &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".test.tsx") &&
      !f.includes("/test-utils/") &&
      !f.includes("node_modules/"),
  );

  const graph = buildDependencyGraph(files);
  const cycles = findMinimalCycles(graph);

  if (cycles.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`✓ No circular imports detected across ${graph.size} files`);
    return;
  }

  const withinThreshold = maxCycles > 0 && cycles.length <= maxCycles;
  const status = withinThreshold ? "⚠" : "✗";
  const stream = withinThreshold ? console.log : console.error;

  // eslint-disable-next-line no-console
  stream(
    `${status} Found ${cycles.length} circular import chain(s)${maxCycles > 0 ? ` (threshold: ${maxCycles})` : ""}:\n`,
  );

  for (const cycle of cycles) {
    // eslint-disable-next-line no-console
    stream(`  ${cycle.join(" → ")} → ${cycle[0]}`);
  }

  if (!withinThreshold) {
    process.exitCode = 1;
  }
}

await main();
