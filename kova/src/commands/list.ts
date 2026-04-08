import { listKovaBackends, listKovaTargets } from "../backends/registry.js";
import type { KovaRunTarget } from "../backends/types.js";
import { listKovaQaScenarios, summarizeKovaQaSurfaces } from "../catalog/qa.js";

function parseListArgs(args: string[]) {
  const [subject, maybeTarget] = args;
  const target = maybeTarget === "qa" ? maybeTarget : undefined;
  return {
    subject: subject ?? "inventory",
    target,
  };
}

function renderTargetLines() {
  return ["Targets:", ...listKovaTargets().map((target) => `  - ${target}`)];
}

function renderBackendLines(target?: KovaRunTarget) {
  const heading = target ? `Backends (${target}):` : "Backends:";
  return [
    heading,
    ...listKovaBackends(target).map((backend) => `  - ${backend.id}: ${backend.title}`),
  ];
}

function renderScenarioLines(target?: KovaRunTarget) {
  const resolvedTarget: "qa" = target ?? "qa";
  const scenarios = listKovaQaScenarios();
  return [
    `Scenarios (${resolvedTarget}):`,
    ...scenarios.map(
      (scenario) =>
        `  - ${scenario.id}: ${scenario.title} [${scenario.surface}] (${scenario.sourcePath})`,
    ),
  ];
}

function renderSurfaceLines(target?: KovaRunTarget) {
  const resolvedTarget: "qa" = target ?? "qa";
  return [
    `Surfaces (${resolvedTarget}):`,
    ...summarizeKovaQaSurfaces().map(
      (surface) => `  - ${surface.surface}: ${surface.scenarioCount} scenario(s)`,
    ),
  ];
}

export async function listCommand(args: string[]) {
  const options = parseListArgs(args);

  if (options.subject === "targets") {
    process.stdout.write(`${renderTargetLines().join("\n")}\n`);
    return;
  }

  if (options.subject === "backends") {
    process.stdout.write(`${renderBackendLines(options.target).join("\n")}\n`);
    return;
  }

  if (options.subject === "scenarios") {
    process.stdout.write(`${renderScenarioLines(options.target).join("\n")}\n`);
    return;
  }

  if (options.subject === "surfaces") {
    process.stdout.write(`${renderSurfaceLines(options.target).join("\n")}\n`);
    return;
  }

  if (options.subject === "inventory") {
    const scenarioCount = listKovaQaScenarios().length;
    const surfaceCount = summarizeKovaQaSurfaces().length;
    const lines = [
      ...renderTargetLines(),
      "",
      ...renderBackendLines(),
      "",
      `QA Catalog: ${scenarioCount} scenario(s) across ${surfaceCount} surface(s)`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  throw new Error(`unsupported kova list subject: ${options.subject}`);
}
