import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = ".artifacts/dependency-cruiser";
const TARGETS = ["src", "extensions", "scripts"];
const TOP_SCOPE_COUNT = 15;
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

function scopeOf(filePath) {
  const segments = filePath.split("/");
  if (segments[0] === "extensions" && segments[1]) {
    return `extensions/${segments[1]}`;
  }
  if (segments[0] === "src" && segments[1] === "channels" && segments[2]) {
    return `src/channels/${segments[2]}`;
  }
  if (segments[0] === "src" && segments[1] === "plugins" && segments[2]) {
    return `src/plugins/${segments[2]}`;
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
      const scopes = new Map();
      for (const moduleName of modules) {
        const scope = scopeOf(moduleName);
        scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
      }
      return {
        id: index + 1,
        moduleCount: modules.length,
        scopes: summarizeCounts(scopes),
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

function renderScopePie(scopeRows) {
  const slices = scopeRows.slice(0, TOP_PIE_COUNT);
  const otherCount = scopeRows.slice(TOP_PIE_COUNT).reduce((sum, row) => sum + row.moduleCount, 0);
  if (otherCount > 0) {
    slices.push({ name: "other", moduleCount: otherCount });
  }
  return [
    "```mermaid",
    "pie showData",
    "  title Cycle modules by scope",
    ...slices.map((row) => `  "${row.name}" : ${row.moduleCount}`),
    "```",
  ].join("\n");
}

function renderSccGraph(sccRows) {
  const lines = ["```mermaid", "flowchart LR"];
  for (const scc of sccRows.slice(0, TOP_SCC_COUNT)) {
    const sccId = `scc_${scc.id}`;
    lines.push(`  ${sccId}["SCC ${scc.id}\\n${scc.moduleCount} modules"]`);
    for (const [scopeIndex, scope] of scc.scopes.slice(0, 4).entries()) {
      const scopeId = `${sccId}_scope_${scopeIndex + 1}`;
      lines.push(`  ${scopeId}["${scope.name}\\n${scope.moduleCount} modules"]`);
      lines.push(`  ${sccId} --> ${scopeId}`);
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

function main() {
  const { outputDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outputDir, { recursive: true });

  const depcruiseBin = path.resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "depcruise.cmd" : "depcruise",
  );
  const depcruise = spawnSync(
    depcruiseBin,
    [
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
      shell: process.platform === "win32",
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
  const cyclicComponents = findStronglyConnectedComponents(graph).filter(
    // Treat self-imports as one-module SCCs so they still show up in the cycle summaries.
    (component) => component.length > 1 || selfImportModuleSet.has(component[0]),
  );
  const sortedSccs = summarizeSccs(cyclicComponents);
  const cycleModules = new Set(sortedSccs.flatMap((component) => component.modules));

  const scopeCounts = new Map();
  const directoryCounts = new Map();
  for (const moduleName of cycleModules) {
    const scope = scopeOf(moduleName);
    const directory = path.posix.dirname(moduleName);
    scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  }

  const sortedScopes = summarizeCounts(scopeCounts);
  const sortedDirectories = summarizeCounts(directoryCounts);
  const largestSccSizes = sortedSccs.slice(0, 5).map((component) => component.moduleCount);

  const summary = {
    cycleViolationCount: cycleViolations.length,
    cyclicComponentCount: sortedSccs.length,
    cycleModuleCount: cycleModules.size,
    selfImportModuleCount: selfImportModules.length,
    selfImportModules,
    cruisedModuleCount: depcruiseJson.modules?.length ?? 0,
    runtimeEdgeCount,
    largestSccSizes,
    scopes: sortedScopes,
    directories: sortedDirectories,
    sccs: sortedSccs.map((component) => ({
      id: component.id,
      moduleCount: component.moduleCount,
      scopes: component.scopes,
      sampleModules: component.modules.slice(0, 8),
    })),
  };

  writeFileSync(path.join(outputDir, "depcruise.json"), depcruise.stdout, "utf8");
  writeFileSync(path.join(outputDir, "depcruise.stderr.txt"), depcruise.stderr ?? "", "utf8");
  writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(
    path.join(outputDir, "cycle-violations.txt"),
    cycleViolations.map(formatCycleViolation).join("\n\n"),
    "utf8",
  );

  const fullScopeTable = renderTable(
    ["Scope", "Modules In Cycles"],
    sortedScopes.map((row) => [row.name, String(row.moduleCount)]),
  );
  const fullDirectoryTable = renderTable(
    ["Directory", "Modules In Cycles"],
    sortedDirectories.map((row) => [row.name, String(row.moduleCount)]),
  );
  const fullSccTable = renderTable(
    ["SCC", "Modules", "Scopes", "Sample Modules"],
    sortedSccs.map((component) => [
      `SCC ${component.id}`,
      String(component.moduleCount),
      component.scopes.map((scope) => `${scope.name} (${scope.moduleCount})`).join(", "),
      component.modules.slice(0, 4).join("<br>"),
    ]),
  );
  const fullSelfImportTable = renderTable(
    ["Module", "Scope"],
    selfImportModules.map((moduleName) => [moduleName, scopeOf(moduleName)]),
  );

  const reportLines = [
    "# Circular Dependency Report",
    "",
    `- Targets: ${TARGETS.join(", ")}`,
    `- Cruised modules: ${depcruiseJson.modules?.length ?? 0}`,
    `- Runtime edges analyzed: ${runtimeEdgeCount}`,
    `- dependency-cruiser cycle violations: ${cycleViolations.length}`,
    `- Distinct cyclic strongly connected components: ${sortedSccs.length}`,
    `- Modules participating in cycles: ${cycleModules.size}`,
    `- Self-import cycles (super weird): ${selfImportModules.length}`,
    `- Largest SCC sizes: ${largestSccSizes.join(", ") || "none"}`,
    "",
    "## Self-Import Cycles (Super Weird)",
    "",
    "These are modules that resolve an import back to themselves. They are rare and usually worth investigating first.",
    "",
    ...(selfImportModules.length > 0
      ? [
          renderTable(
            ["Module", "Scope"],
            selfImportModules
              .slice(0, TOP_SELF_IMPORT_COUNT)
              .map((moduleName) => [moduleName, scopeOf(moduleName)]),
          ),
          "",
          ...(selfImportModules.length > TOP_SELF_IMPORT_COUNT
            ? [
                "<details>",
                "<summary>Full self-import list</summary>",
                "",
                fullSelfImportTable,
                "",
                "</details>",
                "",
              ]
            : []),
        ]
      : ["None detected in this run.", ""]),
    "## Scope Distribution",
    "",
    renderScopePie(sortedScopes),
    "",
    renderTable(
      ["Scope", "Modules In Cycles"],
      sortedScopes.slice(0, TOP_SCOPE_COUNT).map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    "<details>",
    "<summary>Full scope list</summary>",
    "",
    fullScopeTable,
    "",
    "</details>",
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
    "## Largest SCCs",
    "",
    renderSccGraph(sortedSccs),
    "",
    renderTable(
      ["SCC", "Modules", "Scopes", "Sample Modules"],
      sortedSccs
        .slice(0, TOP_SCC_COUNT)
        .map((component) => [
          `SCC ${component.id}`,
          String(component.moduleCount),
          component.scopes.map((scope) => `${scope.name} (${scope.moduleCount})`).join(", "),
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
    "## Artifacts",
    "",
    `- Raw dependency-cruiser JSON: \`${path.posix.join(outputDir, "depcruise.json")}\``,
    `- Machine summary: \`${path.posix.join(outputDir, "summary.json")}\``,
    `- Full cycle listing: \`${path.posix.join(outputDir, "cycle-violations.txt")}\``,
  ];
  writeFileSync(path.join(outputDir, "report.md"), `${reportLines.join("\n")}\n`, "utf8");

  const stepSummaryLines = [
    "## Circular Dependency Report",
    "",
    `- Cycle violations: ${cycleViolations.length}`,
    `- Distinct cyclic SCCs: ${sortedSccs.length}`,
    `- Modules in cycles: ${cycleModules.size}`,
    `- Self-import cycles (super weird): ${selfImportModules.length}`,
    `- Largest SCC sizes: ${largestSccSizes.join(", ") || "none"}`,
    "",
    ...(selfImportModules.length > 0
      ? [
          renderTable(
            ["Module", "Scope"],
            selfImportModules
              .slice(0, TOP_SELF_IMPORT_COUNT)
              .map((moduleName) => [moduleName, scopeOf(moduleName)]),
          ),
        ]
      : ["No self-import cycles detected."]),
    "",
    renderScopePie(sortedScopes),
    "",
    renderTable(
      ["Scope", "Modules In Cycles"],
      sortedScopes.slice(0, TOP_SCOPE_COUNT).map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    renderTable(
      ["Directory", "Modules In Cycles"],
      sortedDirectories.slice(0, 10).map((row) => [row.name, String(row.moduleCount)]),
    ),
    "",
    renderTable(
      ["SCC", "Modules", "Scopes"],
      sortedSccs
        .slice(0, TOP_SCC_COUNT)
        .map((component) => [
          `SCC ${component.id}`,
          String(component.moduleCount),
          component.scopes.map((scope) => `${scope.name} (${scope.moduleCount})`).join(", "),
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
