// Qa Lab helper module supports run config behavior.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { defaultQaModelForMode as defaultStaticQaModelForMode } from "./model-selection.js";
import { defaultQaRuntimeModelForMode } from "./model-selection.runtime.js";
import {
  DEFAULT_QA_LIVE_PROVIDER_MODE,
  getQaProvider,
  isQaProviderModeInput,
  normalizeQaProviderMode as normalizeQaProviderModeInput,
  type QaProviderMode,
} from "./providers/index.js";
import type { QaSeedScenario } from "./scenario-catalog.js";
import {
  qaScorecardChannelDriverSchema,
  type QaScorecardChannelDriver,
} from "./scorecard-taxonomy.js";

export type { QaProviderMode } from "./model-selection.js";
export type { QaProviderModeInput } from "./providers/index.js";

export type QaLabRunSelection = {
  channelDriver: QaScorecardChannelDriver;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenarioIds: string[];
};

type QaLabRunArtifacts = {
  outputDir: string;
  evidencePath: string;
  reportPath: string;
  summaryPath: string;
  watchUrl: string;
};

type QaLabRunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: QaLabRunSelection;
  startedAt?: string;
  finishedAt?: string;
  artifacts: QaLabRunArtifacts | null;
  error: string | null;
};

export function defaultQaModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultQaRuntimeModelForMode(mode, alternate ? { alternate: true } : undefined);
}

type QaDefaultModelResolver = (mode: QaProviderMode, alternate?: boolean) => string;

function defaultStaticModelForMode(mode: QaProviderMode, alternate = false) {
  return defaultStaticQaModelForMode(mode, alternate ? { alternate: true } : undefined);
}

function qaLabFlowScenarioIds(scenarios: QaSeedScenario[]) {
  return scenarios
    .filter(
      (scenario) => scenario.execution?.kind === undefined || scenario.execution.kind === "flow",
    )
    .map((scenario) => scenario.id);
}

function createDefaultQaRunSelection(
  scenarios: QaSeedScenario[],
  options?: { resolveDefaultModel?: QaDefaultModelResolver },
): QaLabRunSelection {
  const providerMode: QaProviderMode = DEFAULT_QA_LIVE_PROVIDER_MODE;
  const resolveDefaultModel = options?.resolveDefaultModel ?? defaultQaModelForMode;
  return {
    channelDriver: "qa-channel",
    providerMode,
    primaryModel: resolveDefaultModel(providerMode),
    alternateModel: resolveDefaultModel(providerMode, true),
    fastMode: true,
    scenarioIds: qaLabFlowScenarioIds(scenarios),
  };
}

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === undefined || input === null || input === "") {
    return DEFAULT_QA_LIVE_PROVIDER_MODE;
  }
  if (isQaProviderModeInput(input)) {
    return normalizeQaProviderModeInput(input);
  }
  const details = typeof input === "string" ? `: ${input}` : "";
  throw new Error(`unknown QA provider mode${details}`);
}

function normalizeModel(input: unknown, fallback: string) {
  const value = typeof input === "string" ? input.trim() : "";
  return value || fallback;
}

function normalizeScenarioIds(input: unknown, scenarios: QaSeedScenario[]) {
  const defaultScenarioIds = qaLabFlowScenarioIds(scenarios);
  if (input === undefined) {
    return defaultScenarioIds;
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("QA runner scenarioIds must be a non-empty array");
  }
  const requestedIds = input.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("QA runner scenarioIds must contain non-empty strings");
    }
    return value.trim();
  });
  const selectedIds = uniqueStrings(requestedIds);
  const availableIds = new Set(scenarios.map((scenario) => scenario.id));
  const unknownIds = selectedIds.filter((id) => !availableIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`unknown QA scenario id(s): ${unknownIds.join(", ")}`);
  }
  return selectedIds;
}

function normalizeQaChannelDriver(input: unknown): QaScorecardChannelDriver {
  if (input === undefined || input === null || input === "") {
    return "qa-channel";
  }
  const parsed = qaScorecardChannelDriverSchema.safeParse(input);
  if (!parsed.success) {
    const details = typeof input === "string" ? `: ${input}` : "";
    throw new Error(`unknown QA channel driver${details}`);
  }
  return parsed.data;
}

export function normalizeQaRunSelection(
  input: unknown,
  scenarios: QaSeedScenario[],
): QaLabRunSelection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("QA runner request must be a JSON object");
  }
  const payload = input as Record<string, unknown>;
  const providerMode = normalizeQaProviderMode(payload.providerMode);
  return {
    channelDriver: normalizeQaChannelDriver(payload.channelDriver),
    providerMode,
    primaryModel: normalizeModel(payload.primaryModel, defaultQaModelForMode(providerMode)),
    alternateModel: normalizeModel(
      payload.alternateModel,
      defaultQaModelForMode(providerMode, true),
    ),
    fastMode: getQaProvider(providerMode).kind === "live" || payload.fastMode === true,
    scenarioIds: normalizeScenarioIds(payload.scenarioIds, scenarios),
  };
}

export function createIdleQaRunnerSnapshot(scenarios: QaSeedScenario[]): QaLabRunnerSnapshot {
  return {
    status: "idle",
    selection: createDefaultQaRunSelection(scenarios, {
      resolveDefaultModel: defaultStaticModelForMode,
    }),
    artifacts: null,
    error: null,
  };
}

export function createQaRunOutputDir(baseDir = process.cwd()) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-");
  return path.join(baseDir, ".artifacts", "qa-e2e", `lab-${stamp}-${randomUUID().slice(0, 8)}`);
}
