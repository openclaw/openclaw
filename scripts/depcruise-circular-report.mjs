import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = ".artifacts/dependency-cruiser";
const TARGETS = ["src", "extensions", "scripts"];
const TOP_BOUNDARY_COUNT = 15;
const TOP_DIRECTORY_COUNT = 20;
const TOP_SCC_COUNT = 8;
const TOP_PIE_COUNT = 10;
const TOP_SELF_IMPORT_COUNT = 10;

function parseArgs(argv) {
  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--output-dir" || arg === "-o") && argv[index + 1]) {
      outputDir = argv[index + 1];
      index += 1;
    }
  }
  return { outputDir };
}

function includePath(filePath) {
  return (
    /^(src|extensions|scripts)\//.test(filePath) &&
    !/(^|\/)(coverage|dist|docs|vendor)(\/|$)/.test(filePath) &&
    !/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)
  );
}

function isRuntimeDependency(dependency) {
  return !(dependency.dependencyTypes ?? []).includes("type-only");
}

function boundaryOf(filePath) {
  const segments = filePath.split("/");
  if (segments[0] === "extensions" && segments[1]) {
    return `extensions/${segments[1]}`;
  }
  if (segments[0] === "src" && segments[1] === "channels" && segments[2]) {
    return segments[2].includes(".") ? "src/channels" : `src/channels/${segments[2]}`;
  }
  if (segments[0] === "src" && segments[1] === "plugins" && segments[2]) {
    return segments[2].includes(".") ? "src/plugins" : `src/plugins/${segments[2]}`;
  }
  if (segments[0] === "src" && segments[1]) {
    return `src/${segments[1]}`;
  }
  return segments[0] ?? filePath;
}

function escapeTable(value) {
  return String(value).replaceAll("|", "\\|");
}

function renderTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(escapeTable).join(" | ")} |`);
  return [headerLine, separatorLine, ...body].join("\n");
}

function summarizeCounts(values) {
  return [...values.entries()]
    .map(([name, moduleCount]) => ({ name, moduleCount }))
    .toSorted(
      (left, right) => right.moduleCount - left.moduleCount || left.name.localeCompare(right.name),
    );
}

function buildGraph(modules) {
  const graph = new Map();
  let runtimeEdgeCount = 0;
  for (const mod of modules) {
    if (!includePath(mod.source)) {
      continue;
    }
    const dependencies = [];
    for (const dependency of mod.dependencies ?? []) {
      const target = dependency.resolved;
      if (!target || !includePath(target) || !isRuntimeDependency(dependency)) {
        continue;
      }
      dependencies.push(target);
      runtimeEdgeCount += 1;
    }
    graph.set(mod.source, dependencies);
  }

  for (const dependencies of graph.values()) {
    for (const target of dependencies) {
      if (!graph.has(target)) {
        graph.set(target, []);
      }
    }
  }

  return { graph, runtimeEdgeCount };
}

function findStronglyConnectedComponents(graph) {
  const reverseGraph = new Map([...graph.keys()].map((node) => [node, []]));
  for (const [from, dependencies] of graph.entries()) {
    for (const to of dependencies) {
      const reverseDependencies = reverseGraph.get(to);
      if (reverseDependencies) {
        reverseDependencies.push(from);
      } else {
        reverseGraph.set(to, [from]);
      }
    }
  }

  const visited = new Set();
  const finishOrder = [];
  for (const node of graph.keys()) {
    if (visited.has(node)) {
      continue;
    }

    const stack = [[node, false]];
    while (stack.length > 0) {
      const [current, expanded] = stack.pop();
      if (expanded) {
        finishOrder.push(current);
        continue;
      }
      if (visited.has(current)) {
        continue;
      }

      visited.add(current);
      stack.push([current, true]);
      const neighbors = graph.get(current) ?? [];
      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighbor = neighbors[index];
        if (!visited.has(neighbor)) {
          stack.push([neighbor, false]);
        }
      }
    }
  }

  const assigned = new Set();
  const components = [];
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const node = finishOrder[index];
    if (assigned.has(node)) {
      continue;
    }

    const component = [];
    const stack = [node];
    assigned.add(node);
    while (stack.length > 0) {
      const current = stack.pop();
      component.push(current);
      for (const neighbor of reverseGraph.get(current) ?? []) {
        if (assigned.has(neighbor)) {
          continue;
        }
        assigned.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }

  return components;
}

function summarizeSccs(components) {
  return components
    .map((modules, index) => {
      const boundaries = new Map();
      for (const moduleName of modules) {
        const boundary = boundaryOf(moduleName);
        boundaries.set(boundary, (boundaries.get(boundary) ?? 0) + 1);
      }
      return {
        id: index + 1,
        moduleCount: modules.length,
        boundaryCount: boundaries.size,
        boundaries: summarizeCounts(boundaries),
        modules: [...modules].toSorted((left, right) => left.localeCompare(right)),
      };
    })
    .toSorted((left, right) => right.moduleCount - left.moduleCount || left.id - right.id);
}

function findSelfImportModules(graph) {
  return [...graph.entries()]
    .filter(([moduleName, dependencies]) => dependencies.includes(moduleName))
    .map(([moduleName]) => moduleName)
    .toSorted((left, right) => left.localeCompare(right));
}

function renderBoundaryPie(boundaryRows) {
  const slices = boundaryRows.slice(0, TOP_PIE_COUNT);
  const otherCount = boundaryRows
    .slice(TOP_PIE_COUNT)
    .reduce((sum, row) => sum + row.moduleCount, 0);
  if (otherCount > 0) {
    slices.push({ name: "other", moduleCount: otherCount });
  }
  return [
    "```mermaid",
    "pie showData",
    "  title Cross-boundary cycle modules by boundary",
    ...slices.map((row) => `  "${row.name}" : ${row.moduleCount}`),
    "```",
  ].join("\n");
}

function renderSccGraph(sccRows) {
  const lines = ["```mermaid", "flowchart LR"];
  for (const scc of sccRows.slice(0, TOP_SCC_COUNT)) {
    const sccId = `scc_${scc.id}`;
    lines.push(`  ${sccId}["SCC ${scc.id}\\n${scc.moduleCount} modules"]`);
    for (const [boundaryIndex, boundary] of scc.boundaries.slice(0, 4).entries()) {
      const boundaryId = `${sccId}_boundary_${boundaryIndex + 1}`;
      lines.push(`  ${boundaryId}["${boundary.name}\\n${boundary.moduleCount} modules"]`);
      lines.push(`  ${sccId} --> ${boundaryId}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

function renderBoundaryEdgeGraph(sccRows) {
  const lines = ["```mermaid", "flowchart LR"];
  const addedNodes = new Set();
  let edgeIndex = 0;

  for (const scc of sccRows.slice(0, TOP_SCC_COUNT)) {
    const boundaries = scc.boundaries.map((boundary) => boundary.name);
    for (const boundary of boundaries) {
      const nodeId = boundary.replaceAll(/[^a-zA-Z0-9_]/g, "_");
      if (addedNodes.has(nodeId)) {
        continue;
      }
      addedNodes.add(nodeId);
      lines.push(`  ${nodeId}["${boundary}"]`);
    }
    for (let index = 0; index < boundaries.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < boundaries.length; nextIndex += 1) {
        const left = boundaries[index].replaceAll(/[^a-zA-Z0-9_]/g, "_");
        const right = boundaries[nextIndex].replaceAll(/[^a-zA-Z0-9_]/g, "_");
        edgeIndex += 1;
        lines.push(`  ${left} --- edge_${edgeIndex}["SCC ${scc.id}"] --- ${right}`);
      }
    }
  }

  lines.push("```");
  return lines.join("\n");
}

function formatCycleViolation(violation, index) {
  const members = [violation.from, ...(violation.cycle ?? []).map((entry) => entry.name)];
  return [
    `[${index + 1}] ${violation.from}`,
    ...members.slice(1).map((member) => `  -> ${member}`),
  ].join("\n");
}

function boundariesForViolation(violation) {
  const members = [violation.from, ...(violation.cycle ?? []).map((entry) => entry.name)];
  return [...new Set(members.map((member) => boundaryOf(member)))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function main() {
  const { outputDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outputDir, { recursive: true });

  const depcruiseBin = path.resolve(
    "node_modules",
    "dependency-cruiser",
    "bin",
    "dependency-cruise.mjs",
  );
  const depcruise = spawnSync(
    process.execPath,
    [
      depcruiseBin,
      "--config",
      ".dependency-cruiser.mjs",
      "--output-type",
      "json",
      "--progress",
      "none",
      ...TARGETS,
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    },
  );

  if (depcruise.error) {
    throw depcruise.error;
  }
  if (!depcruise.stdout.trim()) {
    throw new Error("dependency-cruiser did not produce JSON output");
  }

  const depcruiseJson = JSON.parse(depcruise.stdout);
  const cycleViolations = (depcruiseJson.summary?.violations ?? []).filter(
    (violation) => violation.type === "cycle" && violation.rule?.name === "no-circular",
  );
  const { graph, runtimeEdgeCount } = buildGraph(depcruiseJson.modules ?? []);
  const selfImportModules = findSelfImportModules(graph);
  const selfImportModuleSet = new Set(selfImportModules);
  const allCyclicComponents = findStronglyConnectedComponents(graph).filter(
    // Treat self-imports as one-module SCCs so they still show up in the cycle summaries.
    (component) => component.length > 1 || selfImportModuleSet.has(component[0]),
  );
  const boundaryCrossingComponents = allCyclicComponents.filter((component) => {
    const boundaries = new Set(component.map((moduleName) => boundaryOf(moduleName)));
    return boundaries.size > 1;
  });
  const internalOnlyComponents = allCyclicComponents.filter((component) => {
    const boundaries = new Set(component.map((moduleName) => boundaryOf(moduleName)));
    return boundaries.size <= 1;
  });
  const boundaryCrossingViolations = cycleViolations.filter(
    (violation) => new Set(boundariesForViolation(violation)).size > 1,
  );
  const internalOnlyViolations = cycleViolations.filter(
    (violation) => new Set(boundariesForViolation(violation)).size <= 1,
  );
  const sortedSccs = summarizeSccs(boundaryCrossingComponents);
  const internalOnlySccs = summarizeSccs(internalOnlyComponents);
  const cycleModules = new Set(sortedSccs.flatMap((component) => component.modules));
  const internalOnlyModules = new Set(internalOnlySccs.flatMap((component) => component.modules));

  const boundaryCounts = new Map();
  const directoryCounts = new Map();
  for (const moduleName of cycleModules) {
    const boundary = boundaryOf(moduleName);
    const directory = path.posix.dirname(moduleName);
    boundaryCounts.set(boundary, (boundaryCounts.get(boundary) ?? 0) + 1);
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }
  const internalOnlyBoundaryCounts = new Map();
  for (const moduleName of internalOnlyModules) {
    const boundary = boundaryOf(moduleName);
    internalOnlyBoundaryCounts.set(boundary, (internalOnlyBoundaryCounts.get(boundary) ?? 0) + 1);
  }

  const sortedBoundaries = summarizeCounts(boundaryCounts);
  const sortedDirectories = summarizeCounts(directoryCounts);
  const sortedInternalOnlyBoundaries = summarizeCounts(internalOnlyBoundaryCounts);
  const largestSccSizes = sortedSccs.slice(0, 5).map((component) => component.moduleCount);
  const hasExtensionBoundaryCrossingCycles = sortedBoundaries.some((row) =>
    row.name.startsWith("extensions/"),
  );

  const summary = {
    allCycleViolationCount: cycleViolations.length,
    boundaryCrossingCycleViolationCount: boundaryCrossingViolations.length,
    internalOnlyCycleViolationCount: internalOnlyViolations.length,
    cyclicComponentCount: sortedSccs.length,
    internalOnlyCyclicComponentCount: internalOnlySccs.length,
    cycleModuleCount: cycleModules.size,
    internalOnlyCycleModuleCount: internalOnlyModules.size,
    selfImportModuleCount: selfImportModules.length,
    selfImportModules,
    cruisedModuleCount: depcruiseJson.modules?.length ?? 0,
    runtimeEdgeCount,
    largestSccSizes,
    boundaries: sortedBoundaries,
    internalOnlyBoundaries: sortedInternalOnlyBoundaries,
    directories: sortedDirectories,
    sccs: sortedSccs.map((component) => ({
      id: component.id,
      moduleCount: component.moduleCount,
      boundaryCount: component.boundaryCount,
      boundaries: component.boundaries,
      sampleModules: component.modules.slice(0, 8),
    })),
  };

  writeFileSync(path.join(outputDir, "depcruise.json"), depcruise.stdout, "utf8");
  writeFileSync(path.join(outputDir, "depcruise.stderr.txt"), depcruise.stderr ?? "", "utf8");
  writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    path.join(outputDir, "cycle-violations-cross-boundary.txt"),
    boundaryCrossingViolations.map(formatCycleViolation).join("\n\n"),
    "utf8",
  );
  writeFileSync(
    path.join(outputDir, "cycle-violations-internal-only.txt"),
    internalOnlyViolations.map(formatCycleViolation).join("\n\n"),
    "utf8",
  );

  const fullBoundaryTable = renderTable(
    ["Boundary", "Modules In Cross-Boundary Cycles"],
    sortedBoundaries.map((row) => [row.name, String(row.moduleCount)]),
  );
  const fullDirectoryTable = renderTable(
    ["Directory", "Modules In Cycles"],
    sortedDirectories.map((row) => [row.name, String(row.moduleCount)]),
  );
  const fullSccTable = renderTable(
    ["SCC", "Modules", "Boundaries", "Sample Modules"],
    sortedSccs.map((component) => [
      `SCC ${component.id}`,
      String(component.moduleCount),
      component.boundaries
        .map((boundary) => `${boundary.name} (${boundary.moduleCount})`)
        .join(", "),
      component.modules.slice(0, 4).join("<br>"),
    ]),
  );
  const fullInternalOnlyBoundaryTable = renderTable(
    ["Boundary", "Modules In Internal-Only Cycles"],
    sortedInternalOnlyBoundaries.map((row) => [row.name, String(row.moduleCount)]),
  );

  const reportLines = [
    "# Circular Dependency Report",
    "",
    `- Targets: ${TARGETS.join(", ")}`,
    `- Cruised modules: ${depcruiseJson.modules?.length ?? 0}`,
    `- Runtime edges analyzed: ${runtimeEdgeCount}`,
    `- All dependency-cruiser cycle violations: ${cycleViolations.length}`,
    `- Cross-boundary cycle violations: ${boundaryCrossingViolations.length}`,
    `- Internal-only cycle violations hidden from this summary: ${internalOnlyViolations.length}`,
    `- Distinct cross-boundary cyclic SCCs: ${sortedSccs.length}`,
    `- Internal-only cyclic SCCs hidden from this summary: ${internalOnlySccs.length}`,
    `- Modules participating in cross-boundary cycles: ${cycleModules.size}`,
    `- Modules participating only in internal cycles: ${internalOnlyModules.size}`,
    `- Self-import cycles (still weird, still internal): ${selfImportModules.length}`,
    `- Largest cross-boundary SCC sizes: ${largestSccSizes.join(", ") || "none"}`,
    "",
    "## What This Summary Counts",
    "",
    "This summary intentionally focuses on SCCs that cross a boundary bucket such as `extensions/xai`, `src/gateway`, or `src/cli`.",
    "",
    "Intra-boundary cycles such as `extensions/xai/foo.ts <-> extensions/xai/bar.ts` are omitted from the headline tables because they do not usually collapse lazy-loading or package boundaries on their own.",
    "",
    ...(hasExtensionBoundaryCrossingCycles
      ? []
      : [
          "No extension-to-core or extension-to-extension cross-boundary cycles were detected in this run.",
          "",
        ]),
    "",
    "## Boundary Distribution",
    "",
    renderBoundaryPie(sortedBoundaries),
    "",
    renderTable(
      ["Boundary", "Modules In Cross-Boundary Cycles"],
      sortedBoundaries
        .slice(0, TOP_BOUNDARY_COUNT)
        .map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    "<details>",
    "<summary>Full boundary list</summary>",
    "",
    fullBoundaryTable,
    "",
    "</details>",
    "",
    "## Boundary Relationship Graph",
    "",
    renderBoundaryEdgeGraph(sortedSccs),
    "",
    "## Exact Directories",
    "",
    renderTable(
      ["Directory", "Modules In Cycles"],
      sortedDirectories
        .slice(0, TOP_DIRECTORY_COUNT)
        .map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    "<details>",
    "<summary>Full directory list</summary>",
    "",
    fullDirectoryTable,
    "",
    "</details>",
    "",
    "## Largest Cross-Boundary SCCs",
    "",
    renderSccGraph(sortedSccs),
    "",
    renderTable(
      ["SCC", "Modules", "Boundaries", "Sample Modules"],
      sortedSccs
        .slice(0, TOP_SCC_COUNT)
        .map((component) => [
          `SCC ${component.id}`,
          String(component.moduleCount),
          component.boundaries
            .map((boundary) => `${boundary.name} (${boundary.moduleCount})`)
            .join(", "),
          component.modules.slice(0, 4).join("<br>"),
        ]),
    ),
    "",
    "<details>",
    "<summary>Full SCC list</summary>",
    "",
    fullSccTable,
    "",
    "</details>",
    "",
    "## Hidden Internal-Only Cycles",
    "",
    "These boundaries currently have cycles, but only within the same boundary bucket, so they are omitted from the main summary.",
    "",
    ...(sortedInternalOnlyBoundaries.length > 0
      ? [
          renderTable(
            ["Boundary", "Modules In Internal-Only Cycles"],
            sortedInternalOnlyBoundaries
              .slice(0, TOP_BOUNDARY_COUNT)
              .map((row) => [row.name, String(row.moduleCount)]),
          ),
          "",
          ...(selfImportModules.length > 0
            ? [
                renderTable(
                  ["Self-Import Module", "Boundary"],
                  selfImportModules
                    .slice(0, TOP_SELF_IMPORT_COUNT)
                    .map((moduleName) => [moduleName, boundaryOf(moduleName)]),
                ),
                "",
              ]
            : []),
          "<details>",
          "<summary>Full internal-only boundary list</summary>",
          "",
          fullInternalOnlyBoundaryTable,
          "",
          "</details>",
          "",
        ]
      : ["None detected in this run.", ""]),
    "",
    "## Artifacts",
    "",
    `- Raw dependency-cruiser JSON: \`${path.posix.join(outputDir, "depcruise.json")}\``,
    `- Machine summary: \`${path.posix.join(outputDir, "summary.json")}\``,
    `- Cross-boundary cycle listing: \`${path.posix.join(outputDir, "cycle-violations-cross-boundary.txt")}\``,
    `- Internal-only cycle listing: \`${path.posix.join(outputDir, "cycle-violations-internal-only.txt")}\``,
  ];
  writeFileSync(path.join(outputDir, "report.md"), `${reportLines.join("\n")}\n`, "utf8");

  const stepSummaryLines = [
    "## Circular Dependency Report",
    "",
    `- Cross-boundary cycle violations: ${boundaryCrossingViolations.length}`,
    `- Internal-only cycle violations hidden from this summary: ${internalOnlyViolations.length}`,
    `- Distinct cross-boundary cyclic SCCs: ${sortedSccs.length}`,
    `- Modules in cross-boundary cycles: ${cycleModules.size}`,
    `- Internal-only cycle modules hidden from this summary: ${internalOnlyModules.size}`,
    `- Self-import cycles (still weird, still internal): ${selfImportModules.length}`,
    `- Largest cross-boundary SCC sizes: ${largestSccSizes.join(", ") || "none"}`,
    "",
    "The tables below intentionally omit cycles that stay inside a single boundary bucket.",
    ...(hasExtensionBoundaryCrossingCycles
      ? []
      : [
          "- No extension-to-core or extension-to-extension cross-boundary cycles were detected in this run.",
        ]),
    "",
    renderBoundaryPie(sortedBoundaries),
    "",
    renderTable(
      ["Boundary", "Modules In Cross-Boundary Cycles"],
      sortedBoundaries
        .slice(0, TOP_BOUNDARY_COUNT)
        .map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    renderTable(
      ["Directory", "Modules In Cycles"],
      sortedDirectories.slice(0, 10).map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    renderTable(
      ["SCC", "Modules", "Boundaries"],
      sortedSccs
        .slice(0, TOP_SCC_COUNT)
        .map((component) => [
          `SCC ${component.id}`,
          String(component.moduleCount),
          component.boundaries
            .map((boundary) => `${boundary.name} (${boundary.moduleCount})`)
            .join(", "),
        ]),
    ),
    "",
    "Full report and raw artifacts are attached to this job.",
  ];
  writeFileSync(
    path.join(outputDir, "step-summary.md"),
    `${stepSummaryLines.join("\n")}\n`,
    "utf8",
  );

  console.log(`Wrote dependency-cruiser report to ${outputDir}`);
}

main();
