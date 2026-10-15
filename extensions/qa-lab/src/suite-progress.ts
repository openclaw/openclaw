import type {
  QaLabScenarioOutcome,
  QaLabScenarioRun,
  QaLabServerHandle,
} from "./lab-server.types.js";

type QaSuiteProgressScenario = {
  id: string;
  title: string;
};

type QaSuiteProgressResult = {
  scenarioIndex: number;
  result: {
    name: string;
    status: "pass" | "fail" | "skip";
    steps: QaLabScenarioOutcome["steps"];
    details?: string;
  };
};

function cloneOutcome(outcome: QaLabScenarioOutcome): QaLabScenarioOutcome {
  return {
    ...outcome,
    ...(outcome.steps ? { steps: outcome.steps.map((step) => ({ ...step })) } : {}),
  };
}

export function createQaSuiteProgressController(params: {
  lab: QaLabServerHandle;
  scenarios: readonly QaSuiteProgressScenario[];
  startedAt: string;
}) {
  // Positions belong to this captured schedule; labels may repeat.
  const outcomes: QaLabScenarioOutcome[] = params.scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.title,
    status: "pending",
  }));

  const emit = (status: QaLabScenarioRun["status"], finishedAt?: string) => {
    params.lab.setScenarioRun({
      kind: "suite",
      status,
      startedAt: params.startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      scenarios: outcomes.map(cloneOutcome),
    });
  };

  const updateResult = (entry: QaSuiteProgressResult, finishedAt?: string) => {
    const current = outcomes[entry.scenarioIndex];
    if (!current) {
      return;
    }
    outcomes[entry.scenarioIndex] = {
      ...current,
      name: entry.result.name,
      status: entry.result.status,
      ...(entry.result.details ? { details: entry.result.details } : {}),
      ...(entry.result.steps ? { steps: entry.result.steps } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    };
  };

  return {
    start() {
      emit("running");
    },
    markRunning(scenarioIndexes: readonly number[]) {
      const startedAt = new Date().toISOString();
      for (const scenarioIndex of scenarioIndexes) {
        const current = outcomes[scenarioIndex];
        if (!current || current.status !== "pending") {
          continue;
        }
        outcomes[scenarioIndex] = { ...current, status: "running", startedAt };
      }
      emit("running");
    },
    recordScenarioResult(scenarioIndex: number, result: QaSuiteProgressResult["result"]) {
      // Runner outcomes retain catalog titles and assign even empty details.
      // Aggregate results below instead merge names/details from child reports.
      outcomes[scenarioIndex] = {
        ...outcomes[scenarioIndex]!,
        status: result.status,
        details: result.details,
        steps: result.steps,
        finishedAt: new Date().toISOString(),
      };
      emit("running");
    },
    recordResults(entries: readonly QaSuiteProgressResult[]) {
      const finishedAt = new Date().toISOString();
      for (const entry of entries) {
        updateResult(entry, finishedAt);
      }
      emit("running");
    },
    createPartitionLab(scenarioIndexes: readonly number[]): QaLabServerHandle {
      return {
        ...params.lab,
        setScenarioRun(next) {
          if (!next) {
            return;
          }
          // The parent supplied this exact ordered child schedule. A child's
          // repeated labels cannot update another scheduled instance.
          for (const [offset, nextOutcome] of next.scenarios.entries()) {
            const index = scenarioIndexes[offset];
            const current = index === undefined ? undefined : outcomes[index];
            if (index === undefined || !current || current.id !== nextOutcome.id) {
              continue;
            }
            outcomes[index] = { ...current, ...nextOutcome };
          }
          emit("running");
        },
        // Child reports are partial; the unified owner publishes the aggregate.
        setLatestReport() {},
      };
    },
    complete(entries: readonly QaSuiteProgressResult[], finishedAt: string) {
      for (const entry of entries) {
        updateResult(entry, finishedAt);
      }
      emit("completed", finishedAt);
    },
  };
}
