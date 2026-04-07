import path from "node:path";
import {
  defaultQaModelForMode,
  isQaFastModeEnabled,
  type QaProviderMode,
} from "./model-selection.js";
import type { QaSeedScenario } from "./scenario-catalog.js";

export type QaLabRunSelection = {
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenarioIds: string[];
};

export type QaLabRunArtifacts = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  watchUrl: string;
};

export type QaLabRunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: QaLabRunSelection;
  startedAt?: string;
  finishedAt?: string;
  artifacts: QaLabRunArtifacts | null;
  error: string | null;
};

export function createDefaultQaRunSelection(scenarios: QaSeedScenario[]): QaLabRunSelection {
  const providerMode: QaProviderMode = "mock-openai";
  const primaryModel = defaultQaModelForMode(providerMode);
  const alternateModel = defaultQaModelForMode(providerMode, { alternate: true });
  return {
    providerMode,
    primaryModel,
    alternateModel,
    fastMode: isQaFastModeEnabled({ primaryModel, alternateModel }),
    scenarioIds: scenarios.map((scenario) => scenario.id),
  };
}

function normalizeProviderMode(input: unknown): QaProviderMode {
  return input === "live-openai" ? "live-openai" : "mock-openai";
}

function normalizeModel(input: unknown, fallback: string) {
  const value = typeof input === "string" ? input.trim() : "";
  return value || fallback;
}

function normalizeScenarioIds(input: unknown, scenarios: QaSeedScenario[]) {
  const availableIds = new Set(scenarios.map((scenario) => scenario.id));
  const requestedIds = Array.isArray(input)
    ? input
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    : [];
  const selectedIds = requestedIds.filter((id, index) => {
    return availableIds.has(id) && requestedIds.indexOf(id) === index;
  });
  return selectedIds.length > 0 ? selectedIds : scenarios.map((scenario) => scenario.id);
}

export function normalizeQaRunSelection(
  input: unknown,
  scenarios: QaSeedScenario[],
): QaLabRunSelection {
  const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const providerMode = normalizeProviderMode(payload.providerMode);
  const primaryModel = normalizeModel(payload.primaryModel, defaultQaModelForMode(providerMode));
  const alternateModel = normalizeModel(
    payload.alternateModel,
    defaultQaModelForMode(providerMode, { alternate: true }),
  );
  return {
    providerMode,
    primaryModel,
    alternateModel,
    fastMode: isQaFastModeEnabled({ primaryModel, alternateModel }),
    scenarioIds: normalizeScenarioIds(payload.scenarioIds, scenarios),
  };
}

export function createIdleQaRunnerSnapshot(scenarios: QaSeedScenario[]): QaLabRunnerSnapshot {
  return {
    status: "idle",
    selection: createDefaultQaRunSelection(scenarios),
    artifacts: null,
    error: null,
  };
}

export function createQaRunOutputDir(baseDir = process.cwd()) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
  return path.join(baseDir, ".artifacts", "qa-e2e", `lab-${stamp}`);
}
