import { AsyncLocalStorage } from "node:async_hooks";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import type { CodeModeRunFinalQuiescence } from "../code-mode-activity.js";
import { cloneCodeModeStats, createCodeModeStats, mergeCodeModeStats } from "../code-mode-stats.js";
import type {
  EmbeddedRunAccountingObservation,
  EmbeddedRunOpaqueWorkReason,
} from "../embedded-agent-runner/run/accounting-observers.js";
import type { ToolSummaryTrace } from "../embedded-agent-runner/types.js";
import { resolveNormalizedUsageObservedBuckets } from "../usage.js";
import type {
  AgentCommandCandidateRuntime,
  AgentCommandRunAccountingCoverage,
  AgentCommandRunAccountingCoverageReason,
  AgentCommandRunAccountingSnapshot,
  AgentCommandRunUsageBucket,
  AgentCommandRunCandidateAccounting,
  RunAccountingAccumulator,
} from "./run-accounting.types.js";

const MAX_AGENT_COMMAND_ACCOUNTING_CANDIDATES = 32;
const MAX_AGENT_COMMAND_ACCOUNTING_EFFECTIVE_MODELS = 8;
const MAX_AGENT_COMMAND_ACCOUNTING_IDENTITY_CHARS = 256;
const MAX_AGENT_COMMAND_ACCOUNTING_TOOL_NAMES = 64;
const USAGE_BUCKETS: readonly AgentCommandRunUsageBucket[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoningTokens",
  "total",
];
const PRICEABLE_USAGE_BUCKETS: readonly AgentCommandRunUsageBucket[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
];

const snapshots = new WeakMap<object, AgentCommandRunAccountingSnapshot>();
const activeCommandRunAccounting = new AsyncLocalStorage<RunAccountingAccumulator>();

function cloneRunAccountingSnapshot(
  snapshot: AgentCommandRunAccountingSnapshot,
): AgentCommandRunAccountingSnapshot {
  return structuredClone(snapshot);
}

export function bindAgentCommandRunAccounting(
  target: unknown,
  snapshot: AgentCommandRunAccountingSnapshot,
): void {
  if ((typeof target === "object" && target !== null) || typeof target === "function") {
    snapshots.set(target, cloneRunAccountingSnapshot(snapshot));
  }
}

export function resolveAgentCommandRunAccounting(
  target: unknown,
): AgentCommandRunAccountingSnapshot | undefined {
  if ((typeof target === "object" && target !== null) || typeof target === "function") {
    const snapshot = snapshots.get(target);
    return snapshot ? cloneRunAccountingSnapshot(snapshot) : undefined;
  }
  return undefined;
}

export function markActiveAgentCommandOpaqueWork(reason: EmbeddedRunOpaqueWorkReason): void {
  activeCommandRunAccounting.getStore()?.markOpaqueWork(reason);
}

export async function runWithAgentCommandAccounting<T>(
  run: (accounting: RunAccountingAccumulator) => Promise<T>,
): Promise<T> {
  const accounting = createRunAccountingAccumulator();
  return await activeCommandRunAccounting.run(accounting, async () => {
    try {
      return await run(accounting);
    } catch (error) {
      if ((typeof error === "object" && error !== null) || typeof error === "function") {
        bindAgentCommandRunAccounting(error, accounting.project());
      }
      throw error;
    }
  });
}

type MutableCandidateRecord = Omit<
  AgentCommandRunAccountingSnapshot["candidates"]["entries"][number],
  "outcome"
> & {
  outcome?: "returned" | "threw";
};

type MutableRunAccounting = {
  startedAtMs: number;
  candidates: Omit<AgentCommandRunAccountingSnapshot["candidates"], "entries"> & {
    entries: MutableCandidateRecord[];
  };
  candidateIdentityTruncated: boolean;
  agentSubmissions: NonNullable<AgentCommandRunAccountingSnapshot["agentSubmissions"]>;
  assistantTurns: number;
  assistantTurnsObserved: number;
  usage: Record<AgentCommandRunUsageBucket, { value: number; observed: number }>;
  usageObserved: number;
  usageMissing: number;
  usagePartial: number;
  toolSummary: ToolSummaryTrace;
  toolNamesTruncated: boolean;
  toolsObserved: number;
  attemptsObserved: number;
  costUsd: number;
  costObserved: number;
  costMissingPricing: number;
  costPartialUsage: number;
  costTieredAggregate: number;
  opaqueWorkReasons: Set<AgentCommandRunAccountingCoverageReason>;
  codeModeEngaged: boolean;
  codeModeStats?: ReturnType<typeof createCodeModeStats>;
  codeModeAttempts: number;
  codeModeLifecycleObserved: number;
  codeModeLifecycleMissing: number;
  maxUnresolvedAtExtraction: number;
  attemptsWithUnresolved: number;
  codeModeFinalQuiescence?: CodeModeRunFinalQuiescence;
};

function boundAccountingIdentity(value: string): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  return characters.length > MAX_AGENT_COMMAND_ACCOUNTING_IDENTITY_CHARS
    ? {
        value: characters.slice(0, MAX_AGENT_COMMAND_ACCOUNTING_IDENTITY_CHARS).join(""),
        truncated: true,
      }
    : { value, truncated: false };
}

function hasKnownPricing(cost: ReturnType<typeof resolveModelCostConfig>): boolean {
  if (!cost) {
    return false;
  }
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    return cost.tieredPricing.some(
      (tier) => tier.input > 0 || tier.output > 0 || tier.cacheRead > 0 || tier.cacheWrite > 0,
    );
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function createCoverage(
  state: "partial" | "unavailable",
  reasons: Iterable<AgentCommandRunAccountingCoverageReason>,
): AgentCommandRunAccountingCoverage {
  return { state, reasons: [...new Set(reasons)] };
}

function runtimeCoverageReasons(
  runtimes: AgentCommandRunAccountingSnapshot["candidates"]["runtimes"],
): AgentCommandRunAccountingCoverageReason[] {
  const reasons: AgentCommandRunAccountingCoverageReason[] = [];
  if (runtimes.cli > 0) {
    reasons.push("cli_runtime");
  }
  if (runtimes.native > 0) {
    reasons.push("native_runtime");
  }
  if (runtimes.cloud > 0) {
    reasons.push("cloud_runtime");
  }
  if (runtimes.unknown > 0) {
    reasons.push("unknown_runtime");
  }
  return reasons;
}

function projectObservedCoverage(params: {
  state: MutableRunAccounting;
  observed?: number;
  extraReasons?: AgentCommandRunAccountingCoverageReason[];
}): AgentCommandRunAccountingCoverage {
  const reasons = [
    ...runtimeCoverageReasons(params.state.candidates.runtimes),
    ...(params.state.candidates.threw > 0 ? (["candidate_failed"] as const) : []),
    ...(params.extraReasons ?? []),
  ];
  const observed = params.observed ?? params.state.attemptsObserved;
  if (observed === 0) {
    return createCoverage("unavailable", reasons.length > 0 ? reasons : ["not_observed"]);
  }
  if (reasons.length === 0) {
    return { state: "complete" };
  }
  return createCoverage("partial", reasons);
}

function mergeToolSummary(state: MutableRunAccounting, source: ToolSummaryTrace | undefined): void {
  if (!source) {
    return;
  }
  const target = state.toolSummary;
  target.calls += source.calls;
  const tools = new Set(target.tools);
  for (const tool of source.tools) {
    const boundedTool = boundAccountingIdentity(tool);
    state.toolNamesTruncated ||= boundedTool.truncated;
    if (!tools.has(boundedTool.value)) {
      if (target.tools.length >= MAX_AGENT_COMMAND_ACCOUNTING_TOOL_NAMES) {
        state.toolNamesTruncated = true;
        continue;
      }
      tools.add(boundedTool.value);
      target.tools.push(boundedTool.value);
    }
  }
  if (source.failures !== undefined) {
    target.failures = (target.failures ?? 0) + source.failures;
  }
  if (source.totalToolTimeMs !== undefined) {
    target.totalToolTimeMs = (target.totalToolTimeMs ?? 0) + source.totalToolTimeMs;
  }
}

function observeEmbeddedAttempt(
  state: MutableRunAccounting,
  observation: EmbeddedRunAccountingObservation,
  candidate: MutableCandidateRecord | undefined,
): void {
  if (candidate) {
    const provider = boundAccountingIdentity(observation.provider);
    const model = boundAccountingIdentity(observation.model);
    state.candidateIdentityTruncated ||= provider.truncated || model.truncated;
    const alreadyRecorded = candidate.effectiveModels.entries.some(
      (entry) => entry.provider === provider.value && entry.model === model.value,
    );
    if (!alreadyRecorded) {
      if (
        candidate.effectiveModels.entries.length < MAX_AGENT_COMMAND_ACCOUNTING_EFFECTIVE_MODELS
      ) {
        candidate.effectiveModels.entries.push({
          provider: provider.value,
          model: model.value,
        });
      } else {
        candidate.effectiveModels.truncated += 1;
      }
    }
  }
  state.attemptsObserved += 1;
  if (observation.assistantTurnsObserved) {
    state.assistantTurnsObserved += 1;
    state.assistantTurns += observation.assistantTurns ?? 0;
  }
  if (observation.toolsObserved) {
    state.toolsObserved += 1;
    mergeToolSummary(state, observation.toolSummary ?? { calls: 0, tools: [] });
  }

  if (observation.usage) {
    state.usageObserved += 1;
    const observedUsageBuckets = resolveNormalizedUsageObservedBuckets(observation.usage);
    let observedBuckets = 0;
    for (const bucket of USAGE_BUCKETS) {
      const value = observation.usage[bucket];
      if (
        !observedUsageBuckets.has(bucket) ||
        typeof value !== "number" ||
        !Number.isFinite(value)
      ) {
        continue;
      }
      observedBuckets += 1;
      state.usage[bucket].value += value;
      state.usage[bucket].observed += 1;
    }
    if (observedBuckets < USAGE_BUCKETS.length) {
      state.usagePartial += 1;
    }

    const hasPriceableUsage = PRICEABLE_USAGE_BUCKETS.some((bucket) =>
      observedUsageBuckets.has(bucket),
    );
    const hasCompletePriceableUsage = PRICEABLE_USAGE_BUCKETS.every((bucket) =>
      observedUsageBuckets.has(bucket),
    );
    if (!hasPriceableUsage) {
      state.costPartialUsage += 1;
    } else {
      if (!hasCompletePriceableUsage) {
        state.costPartialUsage += 1;
      }
      const cost = resolveModelCostConfig({
        provider: observation.provider,
        model: observation.model,
        config: observation.config,
        agentDir: observation.agentDir,
        allowPluginNormalization: false,
      });
      if (!hasKnownPricing(cost)) {
        state.costMissingPricing += 1;
      } else if ((cost?.tieredPricing?.length ?? 0) > 0) {
        state.costTieredAggregate += 1;
      } else {
        const costUsd = estimateUsageCost({ usage: observation.usage, cost });
        if (costUsd === undefined) {
          state.costMissingPricing += 1;
        } else {
          state.costObserved += 1;
          state.costUsd += costUsd;
        }
      }
    }
  } else {
    state.usageMissing += 1;
  }

  state.codeModeEngaged ||= observation.codeModeEngaged === true;
  const codeModeRelevant =
    observation.codeModeEngaged === true || observation.codeModeStats !== undefined;
  if (!codeModeRelevant) {
    return;
  }
  state.codeModeAttempts += 1;
  if (!observation.codeModeStats) {
    state.codeModeLifecycleMissing += 1;
    return;
  }
  const attemptStats = cloneCodeModeStats(observation.codeModeStats);
  const unresolved = attemptStats.bridgeLifecycle.unresolvedAtExtraction;
  if (observation.codeModeLifecycleObserved && unresolved !== undefined) {
    state.codeModeLifecycleObserved += 1;
    state.maxUnresolvedAtExtraction = Math.max(state.maxUnresolvedAtExtraction, unresolved);
    if (unresolved > 0) {
      state.attemptsWithUnresolved += 1;
    }
  } else {
    state.codeModeLifecycleMissing += 1;
  }
  delete attemptStats.bridgeLifecycle.unresolvedAtExtraction;
  state.codeModeStats ??= createCodeModeStats();
  mergeCodeModeStats(state.codeModeStats, attemptStats);
}

export function createRunAccountingAccumulator(startedAtMs = Date.now()): RunAccountingAccumulator {
  const state: MutableRunAccounting = {
    startedAtMs,
    candidates: {
      total: 0,
      returned: 0,
      threw: 0,
      runtimes: {
        embedded: 0,
        cli: 0,
        native: 0,
        cloud: 0,
        unknown: 0,
      },
      entries: [],
      truncated: 0,
    },
    candidateIdentityTruncated: false,
    agentSubmissions: { total: 0, completed: 0, failed: 0 },
    assistantTurns: 0,
    assistantTurnsObserved: 0,
    usage: {
      input: { value: 0, observed: 0 },
      output: { value: 0, observed: 0 },
      cacheRead: { value: 0, observed: 0 },
      cacheWrite: { value: 0, observed: 0 },
      reasoningTokens: { value: 0, observed: 0 },
      total: { value: 0, observed: 0 },
    },
    usageObserved: 0,
    usageMissing: 0,
    usagePartial: 0,
    toolSummary: { calls: 0, tools: [] },
    toolNamesTruncated: false,
    toolsObserved: 0,
    attemptsObserved: 0,
    costUsd: 0,
    costObserved: 0,
    costMissingPricing: 0,
    costPartialUsage: 0,
    costTieredAggregate: 0,
    opaqueWorkReasons: new Set(),
    codeModeEngaged: false,
    codeModeAttempts: 0,
    codeModeLifecycleObserved: 0,
    codeModeLifecycleMissing: 0,
    maxUnresolvedAtExtraction: 0,
    attemptsWithUnresolved: 0,
  };

  return {
    beginCandidate(identity): AgentCommandRunCandidateAccounting {
      state.candidates.total += 1;
      let runtime: AgentCommandCandidateRuntime = "unknown";
      let settled = false;
      const provider = boundAccountingIdentity(identity.provider);
      const model = boundAccountingIdentity(identity.model);
      state.candidateIdentityTruncated ||= provider.truncated || model.truncated;
      const entry: MutableCandidateRecord | undefined =
        state.candidates.entries.length < MAX_AGENT_COMMAND_ACCOUNTING_CANDIDATES
          ? {
              provider: provider.value,
              model: model.value,
              runtime,
              effectiveModels: { entries: [], truncated: 0 },
            }
          : undefined;
      if (entry) {
        state.candidates.entries.push(entry);
      } else {
        state.candidates.truncated += 1;
      }
      return {
        selectRuntime(nextRuntime) {
          if (runtime === nextRuntime) {
            return;
          }
          if (runtime !== "unknown") {
            throw new Error(
              `agent command candidate runtime changed from ${runtime} to ${nextRuntime}`,
            );
          }
          runtime = nextRuntime;
          if (entry) {
            entry.runtime = nextRuntime;
          }
        },
        beginAgentSubmission() {
          state.agentSubmissions.total += 1;
          let submissionSettled = false;
          return {
            settle(outcome) {
              if (submissionSettled) {
                return;
              }
              submissionSettled = true;
              state.agentSubmissions[outcome] += 1;
            },
          };
        },
        observeEmbeddedAttempt(observation) {
          observeEmbeddedAttempt(state, observation, entry);
        },
        markOpaqueWork(reason) {
          state.opaqueWorkReasons.add(reason);
        },
        settle(outcome) {
          if (settled) {
            return;
          }
          settled = true;
          state.candidates.runtimes[runtime] += 1;
          state.candidates[outcome] += 1;
          if (entry) {
            entry.outcome = outcome;
          }
        },
      };
    },
    markOpaqueWork(reason) {
      state.opaqueWorkReasons.add(reason);
    },
    observeCodeModeFinalQuiescence(finalQuiescence) {
      state.codeModeFinalQuiescence = finalQuiescence;
    },
    project(): AgentCommandRunAccountingSnapshot {
      const runtimeReasons = runtimeCoverageReasons(state.candidates.runtimes);
      const opaqueWorkReasons = [...state.opaqueWorkReasons];
      const settledFinalizationReasons = opaqueWorkReasons.filter(
        (reason) => reason === "settled_finalization_failed",
      );
      const auxiliaryHiddenWorkReasons = opaqueWorkReasons.filter(
        (reason) => reason !== "settled_finalization_failed",
      );
      const candidateCoverageReasons = [
        ...(state.candidates.truncated > 0 ? (["candidate_details_truncated"] as const) : []),
        ...(state.candidateIdentityTruncated ? (["candidate_identity_truncated"] as const) : []),
        ...(state.candidates.entries.some((entry) => entry.effectiveModels.truncated > 0)
          ? (["effective_model_details_truncated"] as const)
          : []),
      ];
      const candidatesCoverage =
        state.candidates.total > 0
          ? candidateCoverageReasons.length > 0
            ? createCoverage("partial", candidateCoverageReasons)
            : ({ state: "complete" } as const)
          : createCoverage("unavailable", ["not_observed"]);
      const agentSubmissionCoverageReasons = [...runtimeReasons, ...auxiliaryHiddenWorkReasons];
      const agentSubmissionsCoverage =
        state.candidates.total === 0
          ? createCoverage("unavailable", ["not_observed", ...agentSubmissionCoverageReasons])
          : agentSubmissionCoverageReasons.length === 0
            ? ({ state: "complete" } as const)
            : createCoverage(
                state.agentSubmissions.total > 0 ? "partial" : "unavailable",
                agentSubmissionCoverageReasons,
              );
      const wholeRunUsageReasons = [
        ...runtimeReasons,
        ...(state.candidates.threw > 0 ? (["candidate_failed"] as const) : []),
      ];
      const usageBuckets = Object.fromEntries(
        USAGE_BUCKETS.map((bucket) => {
          const observed = state.usage[bucket].observed;
          const reasons = [
            ...wholeRunUsageReasons,
            ...(state.usageMissing > 0 ? (["missing_usage"] as const) : []),
            ...(observed < state.attemptsObserved ? (["partial_usage"] as const) : []),
            ...opaqueWorkReasons,
          ];
          return [
            bucket,
            observed === 0
              ? createCoverage("unavailable", reasons.length > 0 ? reasons : ["not_observed"])
              : reasons.length === 0
                ? ({ state: "complete" } as const)
                : createCoverage("partial", reasons),
          ];
        }),
      ) as AgentCommandRunAccountingSnapshot["coverage"]["usageBuckets"];
      const usageCoverage = projectObservedCoverage({
        state,
        observed: state.usageObserved,
        extraReasons: [
          ...(state.usageMissing > 0 ? (["missing_usage"] as const) : []),
          ...(state.usagePartial > 0 ? (["partial_usage"] as const) : []),
          ...opaqueWorkReasons,
        ],
      });
      const costCoverage = projectObservedCoverage({
        state,
        observed: state.costObserved,
        extraReasons: [
          ...(state.usageMissing > 0 ? (["missing_usage"] as const) : []),
          ...(state.costPartialUsage > 0 ? (["partial_usage"] as const) : []),
          ...(state.costMissingPricing > 0 ? (["missing_pricing"] as const) : []),
          ...(state.costTieredAggregate > 0 ? (["tiered_pricing_aggregate"] as const) : []),
          ...opaqueWorkReasons,
        ],
      });
      const projectedUsage = Object.fromEntries(
        USAGE_BUCKETS.flatMap((bucket) =>
          state.usage[bucket].observed > 0 ? [[bucket, state.usage[bucket].value]] : [],
        ),
      ) as NonNullable<AgentCommandRunAccountingSnapshot["usage"]>;
      const codeModeFinalQuiescenceReasons: AgentCommandRunAccountingCoverageReason[] =
        runtimeReasons.length > 0 ? runtimeReasons : ["not_observed"];
      const observedCodeModeFinalQuiescence:
        | Exclude<CodeModeRunFinalQuiescence, "unavailable">
        | undefined =
        state.codeModeFinalQuiescence === "quiescent" ||
        state.codeModeFinalQuiescence === "non_quiescent"
          ? state.codeModeFinalQuiescence
          : undefined;
      const codeModeFinalQuiescenceObserved = observedCodeModeFinalQuiescence !== undefined;
      const codeMode =
        state.codeModeEngaged || state.codeModeStats || codeModeFinalQuiescenceObserved
          ? {
              engaged: state.codeModeEngaged || codeModeFinalQuiescenceObserved,
              ...(state.codeModeStats ? { stats: cloneCodeModeStats(state.codeModeStats) } : {}),
              lifecycle: {
                ...(state.codeModeAttempts > 0 &&
                state.codeModeLifecycleObserved === state.codeModeAttempts
                  ? {
                      maxUnresolvedAtExtraction: state.maxUnresolvedAtExtraction,
                      attemptsWithUnresolved: state.attemptsWithUnresolved,
                    }
                  : {}),
                finalQuiescence: observedCodeModeFinalQuiescence
                  ? { state: observedCodeModeFinalQuiescence }
                  : {
                      state: "unavailable" as const,
                      reasons: codeModeFinalQuiescenceReasons,
                    },
              },
            }
          : undefined;
      return {
        candidates: {
          ...state.candidates,
          runtimes: { ...state.candidates.runtimes },
          entries: state.candidates.entries.flatMap((entry) =>
            entry.outcome
              ? [
                  {
                    ...entry,
                    outcome: entry.outcome,
                    effectiveModels: {
                      entries: entry.effectiveModels.entries.map((identity) => ({ ...identity })),
                      truncated: entry.effectiveModels.truncated,
                    },
                  },
                ]
              : [],
          ),
        },
        ...(agentSubmissionsCoverage.state !== "unavailable"
          ? { agentSubmissions: { ...state.agentSubmissions } }
          : {}),
        ...(state.assistantTurnsObserved > 0 ? { assistantTurns: state.assistantTurns } : {}),
        ...(state.usageObserved > 0 ? { usage: projectedUsage } : {}),
        ...(state.toolsObserved > 0
          ? {
              toolSummary: {
                ...state.toolSummary,
                tools: [...state.toolSummary.tools],
              },
            }
          : {}),
        ...(state.toolNamesTruncated ? { toolNamesTruncated: true as const } : {}),
        ...(state.costObserved > 0 ? { costUsd: state.costUsd } : {}),
        commandExecutionDurationMs: Math.max(0, Date.now() - state.startedAtMs),
        coverage: {
          candidates: candidatesCoverage,
          agentSubmissions: agentSubmissionsCoverage,
          assistantTurns: projectObservedCoverage({
            state,
            observed: state.assistantTurnsObserved,
            extraReasons:
              state.attemptsObserved > state.assistantTurnsObserved
                ? ["not_observed", ...settledFinalizationReasons]
                : settledFinalizationReasons,
          }),
          usage: usageCoverage,
          usageBuckets,
          tools: projectObservedCoverage({
            state,
            observed: state.toolsObserved,
            extraReasons: [
              ...(state.attemptsObserved > state.toolsObserved ? (["not_observed"] as const) : []),
              ...(state.toolNamesTruncated ? (["tool_details_truncated"] as const) : []),
              ...settledFinalizationReasons,
            ],
          }),
          cost: costCoverage,
          agentTime: createCoverage("unavailable", ["not_instrumented"]),
          commandExecutionDuration: { state: "complete" },
          wallLatency: createCoverage("unavailable", ["not_instrumented"]),
          providerTransport: createCoverage("unavailable", [
            "not_instrumented",
            ...auxiliaryHiddenWorkReasons,
          ]),
        },
        ...(codeMode ? { codeMode } : {}),
      };
    },
  };
}
