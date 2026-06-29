// Qa Lab plugin module defines scenario metadata for transport-backed QA runs.
import type {
  LiveTransportScenarioDefinition,
  LiveTransportStandardScenarioId,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";
import type {
  QaTransportActionName,
  QaTransportAdapter,
  QaTransportCapabilities,
} from "./qa-transport.js";

export type QaTransportCapabilityName = keyof QaTransportCapabilities;

export type QaTransportScenarioRequirements = {
  actions?: readonly QaTransportActionName[];
  capabilities?: readonly QaTransportCapabilityName[];
};

export type QaTransportScenarioDefinition<TId extends string = string> =
  LiveTransportScenarioDefinition<TId> & {
    transportRequirements: QaTransportScenarioRequirements;
  };

export type QaTransportScenarioDefinitionInput<TId extends string = string> =
  LiveTransportScenarioDefinition<TId> & {
    transportRequirements?: QaTransportScenarioRequirements;
  };

export type QaTransportScenarioUnsupportedRequirements = {
  actions: QaTransportActionName[];
  capabilities: QaTransportCapabilityName[];
};

const TEXT_REPLY_CAPABILITIES = [
  "assertNoFailureReplies",
  "sendInboundMessage",
  "waitForOutboundMessage",
] as const satisfies readonly QaTransportCapabilityName[];

const NO_REPLY_CAPABILITIES = [
  "assertNoFailureReplies",
  "sendInboundMessage",
  "waitForCondition",
] as const satisfies readonly QaTransportCapabilityName[];

const STANDARD_SCENARIO_REQUIREMENTS = {
  canary: { capabilities: TEXT_REPLY_CAPABILITIES },
  "mention-gating": { capabilities: NO_REPLY_CAPABILITIES },
  "allowlist-block": { capabilities: NO_REPLY_CAPABILITIES },
  "top-level-reply-shape": { capabilities: TEXT_REPLY_CAPABILITIES },
  "quote-reply": { capabilities: TEXT_REPLY_CAPABILITIES },
  "restart-resume": {
    capabilities: [...TEXT_REPLY_CAPABILITIES, "waitForReady"],
  },
  "thread-follow-up": { capabilities: TEXT_REPLY_CAPABILITIES },
  "thread-isolation": {
    capabilities: [...TEXT_REPLY_CAPABILITIES, "waitForCondition"],
  },
  "reaction-observation": {
    capabilities: ["getNormalizedMessageState", "waitForCondition"],
  },
  "help-command": { capabilities: TEXT_REPLY_CAPABILITIES },
} as const satisfies Record<LiveTransportStandardScenarioId, QaTransportScenarioRequirements>;

function uniqueInOrder<T extends string>(values: readonly T[]) {
  const seen = new Set<T>();
  const unique: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

export function mergeQaTransportScenarioRequirements(
  requirements: readonly QaTransportScenarioRequirements[],
): QaTransportScenarioRequirements {
  return {
    actions: uniqueInOrder(requirements.flatMap((requirement) => requirement.actions ?? [])),
    capabilities: uniqueInOrder(
      requirements.flatMap((requirement) => requirement.capabilities ?? []),
    ),
  };
}

export function qaTransportRequirementsForStandardScenario(
  standardId: LiveTransportStandardScenarioId,
): QaTransportScenarioRequirements {
  return STANDARD_SCENARIO_REQUIREMENTS[standardId];
}

export function defineQaTransportScenario<TId extends string>(
  input: QaTransportScenarioDefinitionInput<TId>,
): QaTransportScenarioDefinition<TId> {
  const standardRequirements = input.standardId
    ? qaTransportRequirementsForStandardScenario(input.standardId)
    : {};
  return {
    ...input,
    transportRequirements: mergeQaTransportScenarioRequirements([
      standardRequirements,
      input.transportRequirements ?? {},
    ]),
  };
}

export function findUnsupportedQaTransportScenarioRequirements(params: {
  scenario: QaTransportScenarioDefinition;
  transport: Pick<QaTransportAdapter, "capabilities" | "supportedActions">;
}): QaTransportScenarioUnsupportedRequirements {
  const supportedActions = new Set(params.transport.supportedActions);
  return {
    actions: (params.scenario.transportRequirements.actions ?? []).filter(
      (action) => !supportedActions.has(action),
    ),
    capabilities: (params.scenario.transportRequirements.capabilities ?? []).filter(
      (capability) => typeof params.transport.capabilities[capability] !== "function",
    ),
  };
}

export function assertQaTransportSupportsScenario(params: {
  scenario: QaTransportScenarioDefinition;
  transport: Pick<QaTransportAdapter, "capabilities" | "id" | "supportedActions">;
}) {
  const unsupported = findUnsupportedQaTransportScenarioRequirements(params);
  const problems = [
    unsupported.capabilities.length > 0
      ? `missing capabilities: ${unsupported.capabilities.join(", ")}`
      : undefined,
    unsupported.actions.length > 0
      ? `unsupported actions: ${unsupported.actions.join(", ")}`
      : undefined,
  ].filter((problem): problem is string => Boolean(problem));
  if (problems.length > 0) {
    throw new Error(
      `QA transport ${params.transport.id} cannot run scenario ${params.scenario.id}; ${problems.join("; ")}`,
    );
  }
}

export function filterQaTransportScenariosForTransport<
  TScenario extends QaTransportScenarioDefinition,
>(params: {
  scenarios: readonly TScenario[];
  transport: Pick<QaTransportAdapter, "capabilities" | "supportedActions">;
}): TScenario[] {
  return params.scenarios.filter((scenario) => {
    const unsupported = findUnsupportedQaTransportScenarioRequirements({
      scenario,
      transport: params.transport,
    });
    return unsupported.actions.length === 0 && unsupported.capabilities.length === 0;
  });
}
