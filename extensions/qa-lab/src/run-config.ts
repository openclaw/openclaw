import path from "node:path";
import type { QaSeedScenario } from "./scenario-catalog.js";

export type QaProviderMode = "mock-openai" | "live-openai";

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
  return {
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.4",
    alternateModel: "mock-openai/gpt-5.4-alt",
    fastMode: false,
    scenarioIds: scenarios.map((scenario) => scenario.id),
  };
}

function defaultModelForMode(mode: QaProviderMode, alternate = false) {
  if (mode === "live-openai") {
    return "openai/gpt-5.4";
  }
  return alternate ? "mock-openai/gpt-5.4-alt" : "mock-openai/gpt-5.4";
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
  return {
    providerMode,
    primaryModel: normalizeModel(payload.primaryModel, defaultModelForMode(providerMode)),
    alternateModel: normalizeModel(payload.alternateModel, defaultModelForMode(providerMode, true)),
    fastMode:
      typeof payload.fastMode === "boolean" ? payload.fastMode : providerMode === "live-openai",
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
