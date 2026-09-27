import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import type { QaTestFileScenario } from "./scenario-catalog.js";
import {
  isDockerE2eScenario,
  splitDockerE2eScenarioBatches,
  type runDockerE2eBatch,
} from "./test-file-scenario-docker-batch.js";

type QaTestFileExecutionUnit =
  | {
      kind: "docker-batch";
      order: number;
      scenarios: Parameters<typeof runDockerE2eBatch>[0]["scenarios"];
      timeoutMs: number;
    }
  | {
      kind: "scenario";
      order: number;
      scenario: QaTestFileScenario;
      timeoutMs: number;
    };

function resolveScenarioTimeoutMs(scenario: QaTestFileScenario, commandTimeoutMs: number) {
  return scenario.execution.kind === "script"
    ? resolvePositiveTimerTimeoutMs(scenario.execution.timeoutMs, commandTimeoutMs)
    : commandTimeoutMs;
}

export function buildQaTestFileExecutionUnits(params: {
  commandTimeoutMs: number;
  failFast: boolean;
  scenarios: readonly QaTestFileScenario[];
}): QaTestFileExecutionUnit[] {
  const scenarioOrder = new Map(params.scenarios.map((scenario, index) => [scenario, index]));
  const dockerBatchScenarios =
    !params.failFast && params.scenarios[0]?.execution.kind === "script"
      ? params.scenarios.filter(isDockerE2eScenario)
      : [];
  const dockerBatchGroups = new Map<number, typeof dockerBatchScenarios>();
  for (const scenario of dockerBatchScenarios) {
    const timeoutMs = resolveScenarioTimeoutMs(scenario, params.commandTimeoutMs);
    const group = dockerBatchGroups.get(timeoutMs) ?? [];
    group.push(scenario);
    dockerBatchGroups.set(timeoutMs, group);
  }
  const batchedScenarios = new Set<QaTestFileScenario>(dockerBatchScenarios);
  const units: QaTestFileExecutionUnit[] = [
    ...[...dockerBatchGroups].flatMap(([timeoutMs, scenarios]) =>
      splitDockerE2eScenarioBatches(scenarios).map((batch) => ({
        kind: "docker-batch" as const,
        order: Math.min(...batch.map((scenario) => scenarioOrder.get(scenario) ?? 0)),
        scenarios: batch,
        timeoutMs,
      })),
    ),
    ...params.scenarios
      .filter((scenario) => !batchedScenarios.has(scenario))
      .map((scenario) => ({
        kind: "scenario" as const,
        order: scenarioOrder.get(scenario) ?? 0,
        scenario,
        timeoutMs: resolveScenarioTimeoutMs(scenario, params.commandTimeoutMs),
      })),
  ];
  if (!params.failFast && params.scenarios[0]?.execution.kind === "script") {
    // Native producers stay serial because they may rebuild shared dist output.
    // Longest declared budgets run first so one late producer cannot starve at the suite deadline.
    units.sort((left, right) => right.timeoutMs - left.timeoutMs || left.order - right.order);
  } else {
    units.sort((left, right) => left.order - right.order);
  }
  return units;
}
