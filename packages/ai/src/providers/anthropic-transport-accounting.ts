import type { AiModelFetchProvenance, AiModelTransportOutcome } from "../host.js";
import {
  createModelTransportEventScope,
  type PendingTransportEvent,
} from "../transports/model-transport-accounting-internal.js";
import type { Model, StreamOptions } from "../types.js";
import {
  anthropicRequestEnablesServerFallback,
  resolveAnthropicFallbackModelIdentity,
  type AnthropicFallbackBoundary,
} from "./anthropic-server-fallback.js";

const ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT = Symbol.for(
  "openclaw.anthropicTransportAccountingContext",
);
const ANTHROPIC_TRANSPORT = "sse";

type AnthropicTransportPhaseReason = "initial" | "payload_recovery";
type AnthropicFallbackBoundaryAuthority = "server_authoritative" | "client_provisional";

type AnthropicFallbackTransition = {
  fromModel: string;
  toModel: string;
};

export type AnthropicFallbackResolution = {
  traceValid: boolean;
  transitions: AnthropicFallbackTransition[];
  productTransitions: AnthropicFallbackBoundary[];
  servingModel?: string;
};

type AnthropicTransportAccountingState = {
  events: ReturnType<typeof createModelTransportEventScope>;
};

type AnthropicTransportAccountingContext = {
  state?: AnthropicTransportAccountingState;
  reason: AnthropicTransportPhaseReason;
};

type AnthropicTransportOptions = StreamOptions & {
  [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]?: AnthropicTransportAccountingContext;
};

type TerminalFallbackUsage =
  | { state: "invalid" }
  | {
      state: "valid";
      declinedModels: string[];
      directModelUnknown?: boolean;
      servingModel?: string;
    };

export type AnthropicTransportAccounting = {
  onFetchDispatch: () => void;
  wrapFetch(
    fetch: typeof globalThis.fetch,
    provenance?: AiModelFetchProvenance,
  ): typeof globalThis.fetch;
  observeFinalRequestPayload(payload: unknown): void;
  observeFallbackBoundary(boundary: AnthropicFallbackBoundary): void;
  observeFallbackContent(): void;
  observeTerminalUsage(usage: unknown): void;
  observeSemanticCoverage(
    reason: "transport_terminal_unverified" | "transport_endpoint_authority_partial",
  ): void;
  completeSuccess(): AnthropicFallbackResolution;
  completeFailure(error: unknown): AnthropicFallbackResolution;
  fail(error: unknown): AnthropicFallbackResolution | undefined;
};

function resolveTransportOutcome(
  _error: unknown,
  signal: AbortSignal | undefined,
): AiModelTransportOutcome {
  return signal?.aborted ? "aborted" : "failed";
}

function isAnthropicSdkRetryableResponse(response: Response): boolean {
  const explicit = response.headers.get("x-should-retry");
  if (explicit === "true") {
    return true;
  }
  if (explicit === "false") {
    return false;
  }
  return (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  );
}

function readTerminalFallbackUsage(usage: unknown): TerminalFallbackUsage {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return { state: "invalid" };
  }
  const iterations = (usage as { iterations?: unknown }).iterations;
  if (!Array.isArray(iterations) || iterations.length === 0) {
    return { state: "invalid" };
  }
  const declinedModels: string[] = [];
  let servingModel: string | undefined;
  let directModelUnknown = false;
  let hasServingIdentity = false;
  for (const iteration of iterations) {
    if (!iteration || typeof iteration !== "object" || Array.isArray(iteration)) {
      return { state: "invalid" };
    }
    const record = iteration as { type?: unknown; model?: unknown };
    if (typeof record.type !== "string" || !record.type.trim()) {
      return { state: "invalid" };
    }
    switch (record.type) {
      case "message": {
        if (servingModel !== undefined) {
          return { state: "invalid" };
        }
        if (record.model === undefined) {
          if (directModelUnknown || declinedModels.length > 0) {
            return { state: "invalid" };
          }
          directModelUnknown = true;
          hasServingIdentity = true;
          break;
        }
        if (directModelUnknown || typeof record.model !== "string" || !record.model.trim()) {
          return { state: "invalid" };
        }
        const previousModel = declinedModels.at(-1);
        if (
          !previousModel ||
          resolveAnthropicFallbackModelIdentity(previousModel) !==
            resolveAnthropicFallbackModelIdentity(record.model)
        ) {
          declinedModels.push(record.model);
        }
        hasServingIdentity = true;
        break;
      }
      case "fallback_message": {
        if (
          directModelUnknown ||
          servingModel !== undefined ||
          typeof record.model !== "string" ||
          !record.model.trim()
        ) {
          return { state: "invalid" };
        }
        servingModel = record.model;
        hasServingIdentity = true;
        break;
      }
      case "advisor_message": {
        if (typeof record.model !== "string" || !record.model.trim()) {
          return { state: "invalid" };
        }
        break;
      }
      case "compaction":
        break;
      default:
        return { state: "invalid" };
    }
  }
  if (!hasServingIdentity) {
    return { state: "invalid" };
  }
  return {
    state: "valid",
    declinedModels,
    ...(directModelUnknown ? { directModelUnknown: true } : {}),
    ...(servingModel ? { servingModel } : {}),
  };
}

function createAccountingState(params: {
  model: Model<"anthropic-messages">;
  callId?: string;
  scopeId: string;
}): AnthropicTransportAccountingState {
  return {
    events: createModelTransportEventScope({
      model: params.model,
      callId: params.callId,
      scopeId: params.scopeId,
      eventIdPrefix: "anthropic",
    }),
  };
}

function matchConfirmedProductTransitions(
  observed: AnthropicFallbackBoundary[],
  terminal: AnthropicFallbackTransition[],
): AnthropicFallbackBoundary[] {
  const matched: AnthropicFallbackBoundary[] = [];
  let terminalIndex = 0;
  for (const boundary of observed) {
    const fromIdentity = resolveAnthropicFallbackModelIdentity(boundary.fromModel);
    const toIdentity = resolveAnthropicFallbackModelIdentity(boundary.toModel);
    while (terminalIndex < terminal.length) {
      const transition = terminal[terminalIndex];
      terminalIndex += 1;
      if (
        resolveAnthropicFallbackModelIdentity(transition.fromModel) === fromIdentity &&
        resolveAnthropicFallbackModelIdentity(transition.toModel) === toIdentity
      ) {
        matched.push(boundary);
        break;
      }
    }
  }
  return matched;
}

function provisionalBoundariesMatchTerminal(params: {
  boundaries: Array<{ fromModel: string; toModel: string }>;
  transitions: AnthropicFallbackTransition[];
}): boolean {
  let boundaryIndex = 0;
  for (const transition of params.transitions) {
    const fromIdentity = resolveAnthropicFallbackModelIdentity(transition.fromModel);
    const toIdentity = resolveAnthropicFallbackModelIdentity(transition.toModel);
    const groupStart = boundaryIndex;
    while (
      boundaryIndex < params.boundaries.length &&
      resolveAnthropicFallbackModelIdentity(params.boundaries[boundaryIndex].fromModel) ===
        fromIdentity
    ) {
      boundaryIndex += 1;
    }
    if (
      groupStart === boundaryIndex ||
      resolveAnthropicFallbackModelIdentity(params.boundaries[boundaryIndex - 1].toModel) !==
        toIdentity
    ) {
      return false;
    }
  }
  return boundaryIndex === params.boundaries.length;
}

function reconcileFallback(params: {
  boundaryAuthority: AnthropicFallbackBoundaryAuthority;
  requestedModel: string;
  boundaries: AnthropicFallbackBoundary[];
  confirmedProductTransitions: AnthropicFallbackBoundary[];
  terminalUsage: TerminalFallbackUsage | undefined;
}): AnthropicFallbackResolution {
  const validBoundaries = params.boundaries.filter(
    (boundary): boundary is { fromModel: string; toModel: string } =>
      Boolean(boundary.fromModel?.trim() && boundary.toModel?.trim()),
  );
  const observedProductTransitions = params.confirmedProductTransitions.map((transition) => ({
    ...transition,
  }));

  if (params.terminalUsage?.state !== "valid") {
    return {
      traceValid: false,
      transitions: [],
      productTransitions: observedProductTransitions,
    };
  }

  const requestedIdentity = resolveAnthropicFallbackModelIdentity(params.requestedModel);
  if (!requestedIdentity) {
    return { traceValid: false, transitions: [], productTransitions: [] };
  }
  const servingModel = params.terminalUsage.servingModel;
  if (!servingModel) {
    if (params.terminalUsage.directModelUnknown) {
      return params.boundaries.length === 0
        ? { traceValid: true, transitions: [], productTransitions: [] }
        : { traceValid: false, transitions: [], productTransitions: [] };
    }
    const directTraceValid =
      params.boundaries.length === 0 &&
      params.terminalUsage.declinedModels.every(
        (model) => resolveAnthropicFallbackModelIdentity(model) === requestedIdentity,
      );
    return directTraceValid
      ? { traceValid: true, transitions: [], productTransitions: [] }
      : { traceValid: false, transitions: [], productTransitions: [] };
  }
  const servingIdentity = resolveAnthropicFallbackModelIdentity(servingModel);
  if (!servingIdentity) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions: [],
    };
  }

  const firstDeclinedIdentity = resolveAnthropicFallbackModelIdentity(
    params.terminalUsage.declinedModels[0] ?? null,
  );
  if (
    params.terminalUsage.declinedModels.length > 0 &&
    firstDeclinedIdentity !== requestedIdentity
  ) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions: [],
    };
  }

  const routeModels =
    params.terminalUsage.declinedModels.length > 0
      ? [...params.terminalUsage.declinedModels, servingModel]
      : [params.requestedModel, servingModel];
  const transitions: AnthropicFallbackTransition[] = [];
  const routeIdentities = new Set<string>();
  for (let index = 0; index < routeModels.length - 1; index += 1) {
    const fromModel = index === 0 ? params.requestedModel : routeModels[index];
    const toModel = routeModels[index + 1];
    const fromIdentity = resolveAnthropicFallbackModelIdentity(fromModel ?? null);
    const toIdentity = resolveAnthropicFallbackModelIdentity(toModel ?? null);
    if (
      !fromModel ||
      !toModel ||
      !fromIdentity ||
      !toIdentity ||
      fromIdentity === toIdentity ||
      (index === 0 && fromIdentity !== requestedIdentity)
    ) {
      return {
        traceValid: false,
        transitions: [],
        productTransitions: [],
      };
    }
    if (routeIdentities.has(fromIdentity)) {
      return {
        traceValid: false,
        transitions: [],
        productTransitions: [],
      };
    }
    routeIdentities.add(fromIdentity);
    transitions.push({ fromModel, toModel });
  }
  if (routeIdentities.has(servingIdentity)) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions: [],
    };
  }

  const productTransitions = matchConfirmedProductTransitions(
    observedProductTransitions,
    transitions,
  );
  if (validBoundaries.length !== params.boundaries.length) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions,
    };
  }

  if (params.terminalUsage.declinedModels.length > 0) {
    const boundariesMatch =
      params.boundaryAuthority === "server_authoritative"
        ? validBoundaries.length === transitions.length &&
          validBoundaries.every(
            (boundary, index) =>
              resolveAnthropicFallbackModelIdentity(boundary.fromModel) ===
                resolveAnthropicFallbackModelIdentity(transitions[index]?.fromModel ?? null) &&
              resolveAnthropicFallbackModelIdentity(boundary.toModel) ===
                resolveAnthropicFallbackModelIdentity(transitions[index]?.toModel ?? null),
          )
        : provisionalBoundariesMatchTerminal({
            boundaries: validBoundaries,
            transitions,
          });
    if (!boundariesMatch) {
      return {
        traceValid: false,
        transitions: [],
        productTransitions,
      };
    }
  } else if (validBoundaries.length > 0 || servingIdentity === requestedIdentity) {
    return {
      traceValid: false,
      transitions: [],
      productTransitions,
    };
  }

  return {
    traceValid: true,
    transitions,
    productTransitions: transitions,
    servingModel,
  };
}

export function withAnthropicTransportAccountingPhase<T extends object | undefined>(
  options: T,
  reason: AnthropicTransportPhaseReason,
): T extends object ? T : Record<string, never> {
  const source = options as AnthropicTransportOptions | undefined;
  const context = source?.[ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT];
  return {
    ...options,
    [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]: {
      state: context?.state,
      reason,
    },
  } as T extends object ? T : Record<string, never>;
}

export function inheritAnthropicTransportAccountingContext<T extends object>(
  source: unknown,
  target: T,
): T {
  const context = (source as AnthropicTransportOptions | undefined)?.[
    ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT
  ];
  return context
    ? Object.assign(target, { [ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT]: context })
    : target;
}

export function createAnthropicTransportAccounting(params: {
  fallbackBoundaryAuthority?: AnthropicFallbackBoundaryAuthority;
  maxRetries?: number;
  model: Model<"anthropic-messages">;
  options: StreamOptions | undefined;
  serverFallbackEnabled: boolean;
}): AnthropicTransportAccounting {
  const options = params.options as AnthropicTransportOptions | undefined;
  const context =
    options?.[ANTHROPIC_TRANSPORT_ACCOUNTING_CONTEXT] ??
    ({ reason: "initial" } satisfies AnthropicTransportAccountingContext);
  const state =
    context.state ??
    createAccountingState({
      model: params.model,
      callId: options?.requestId,
      scopeId: options?.requestId ?? `${Date.now()}:${Math.random()}`,
    });
  context.state = state;

  const maxRetries = params.maxRetries ?? options?.maxRetries ?? 0;
  const fallbackBoundaryAuthority =
    params.fallbackBoundaryAuthority ??
    (params.serverFallbackEnabled ? "server_authoritative" : "client_provisional");
  let serverFallbackEnabled = params.serverFallbackEnabled;
  let phaseInvocationCount = 0;
  let currentInvocationOrdinal = 0;
  let phaseAwaitingSubmission = true;
  let completedAttemptAwaitingPotentialRetry = false;
  let retryInvocationAwaitingDispatch = false;
  let zeroSubmissionObservedForInvocation = false;
  let backoffZeroSubmissionObserved = false;
  let fetchProvenance: AiModelFetchProvenance | undefined;
  let fallbackCoverageObserved = false;
  let activeAttempt: PendingTransportEvent | undefined;
  let pendingResponseAttempt: PendingTransportEvent | undefined;
  let pendingResponseStatus: number | undefined;
  let terminalUsage: TerminalFallbackUsage | undefined;
  let terminalFallbackEvidenceObserved = false;
  let finalized = false;
  let finalizedResolution: AnthropicFallbackResolution | undefined;
  const fallbackBoundaries: AnthropicFallbackBoundary[] = [];
  const confirmedProductTransitions: AnthropicFallbackBoundary[] = [];
  let pendingProductTransitions: AnthropicFallbackBoundary[] = [];
  const semanticCoverageReasons = new Set<
    "transport_terminal_unverified" | "transport_endpoint_authority_partial"
  >();

  const settlePending = (outcome: AiModelTransportOutcome) => {
    activeAttempt?.finish(outcome);
    activeAttempt = undefined;
    pendingResponseAttempt?.finish(outcome, pendingResponseStatus);
    pendingResponseAttempt = undefined;
    pendingResponseStatus = undefined;
  };
  const takeActiveAttempt = (): PendingTransportEvent | undefined => {
    const attempt = activeAttempt;
    activeAttempt = undefined;
    return attempt;
  };
  const finishPendingResponse = (outcome: AiModelTransportOutcome): void => {
    pendingResponseAttempt?.finish(outcome, pendingResponseStatus);
    pendingResponseAttempt = undefined;
    pendingResponseStatus = undefined;
  };
  const observeFallbackCoverage = (force = false): void => {
    if (
      fallbackCoverageObserved ||
      (!force && !serverFallbackEnabled && fallbackBoundaries.length === 0)
    ) {
      return;
    }
    fallbackCoverageObserved = true;
    state.events.observeCoverage({
      transport: ANTHROPIC_TRANSPORT,
      scope: "provider_fallbacks",
      state: "lower_bound",
      reason: "terminal_metadata_unavailable",
    });
  };
  const flushSemanticCoverage = (): void => {
    for (const reason of semanticCoverageReasons) {
      state.events.observeCoverage({
        transport: ANTHROPIC_TRANSPORT,
        scope: "transport_semantics",
        state: "unverified",
        reason,
      });
    }
    semanticCoverageReasons.clear();
  };
  const finalizeTerminal = (outcome: AiModelTransportOutcome): AnthropicFallbackResolution => {
    if (finalized) {
      return (
        finalizedResolution ?? {
          traceValid: false,
          transitions: [],
          productTransitions: [],
        }
      );
    }
    const resolution =
      serverFallbackEnabled || fallbackBoundaries.length > 0 || terminalUsage !== undefined
        ? reconcileFallback({
            boundaryAuthority: fallbackBoundaryAuthority,
            requestedModel: params.model.id,
            boundaries: fallbackBoundaries,
            confirmedProductTransitions,
            terminalUsage,
          })
        : {
            traceValid: true,
            transitions: [],
            productTransitions: [],
          };
    if (!resolution.traceValid) {
      const hadPendingResponse = Boolean(pendingResponseAttempt);
      finishPendingResponse(outcome);
      if (!hadPendingResponse) {
        flushSemanticCoverage();
      }
      observeFallbackCoverage(terminalFallbackEvidenceObserved || fallbackBoundaries.length > 0);
      flushSemanticCoverage();
      finalized = true;
      finalizedResolution = resolution;
      return resolution;
    }
    if (resolution.transitions.length > 0 && !pendingResponseAttempt) {
      flushSemanticCoverage();
      observeFallbackCoverage(true);
    } else {
      for (const transition of resolution.transitions) {
        state.events.observeProviderFallback({
          transport: ANTHROPIC_TRANSPORT,
          fromModel: transition.fromModel,
          toModel: transition.toModel,
        });
      }
    }
    finishPendingResponse(outcome);
    flushSemanticCoverage();
    finalized = true;
    finalizedResolution = resolution;
    return resolution;
  };

  return {
    onFetchDispatch: () => {
      if (fetchProvenance !== "dispatch_attested") {
        return;
      }
      phaseAwaitingSubmission = false;
      completedAttemptAwaitingPotentialRetry = false;
      retryInvocationAwaitingDispatch = false;
      zeroSubmissionObservedForInvocation = false;
      backoffZeroSubmissionObserved = false;
      activeAttempt = state.events.startAttempt({
        transport: ANTHROPIC_TRANSPORT,
        reason: currentInvocationOrdinal === 1 ? context.reason : "retry",
      });
    },
    wrapFetch(fetch, provenance) {
      fetchProvenance = provenance;
      return async (input, init) => {
        currentInvocationOrdinal = ++phaseInvocationCount;
        phaseAwaitingSubmission = true;
        retryInvocationAwaitingDispatch = currentInvocationOrdinal > 1;
        completedAttemptAwaitingPotentialRetry = false;
        zeroSubmissionObservedForInvocation = false;
        backoffZeroSubmissionObserved = false;
        activeAttempt = undefined;
        try {
          const response = await fetch(input, init);
          const attempt = takeActiveAttempt();
          if (attempt) {
            if (response.ok) {
              pendingResponseAttempt = attempt;
              pendingResponseStatus = response.status;
            } else {
              attempt.finish("failed", response.status);
              completedAttemptAwaitingPotentialRetry =
                phaseInvocationCount <= maxRetries && isAnthropicSdkRetryableResponse(response);
              phaseAwaitingSubmission = completedAttemptAwaitingPotentialRetry;
              retryInvocationAwaitingDispatch = false;
            }
          }
          return response;
        } catch (error) {
          const attempt = takeActiveAttempt();
          if (attempt) {
            const outcome = resolveTransportOutcome(error, options?.signal);
            attempt.finish(outcome);
            observeFallbackCoverage();
            completedAttemptAwaitingPotentialRetry =
              outcome === "failed" && phaseInvocationCount <= maxRetries;
            phaseAwaitingSubmission = completedAttemptAwaitingPotentialRetry;
            retryInvocationAwaitingDispatch = false;
          } else if (
            fetchProvenance === "dispatch_attested" &&
            phaseAwaitingSubmission &&
            !zeroSubmissionObservedForInvocation
          ) {
            zeroSubmissionObservedForInvocation = true;
            const outcome = options?.signal?.aborted ? "aborted" : "failed";
            state.events.observeZeroSubmission({
              transport: ANTHROPIC_TRANSPORT,
              outcome,
            });
            completedAttemptAwaitingPotentialRetry =
              outcome === "failed" && phaseInvocationCount <= maxRetries;
            phaseAwaitingSubmission = completedAttemptAwaitingPotentialRetry;
          }
          throw error;
        }
      };
    },
    observeFinalRequestPayload(payload) {
      serverFallbackEnabled = anthropicRequestEnablesServerFallback(payload);
    },
    observeFallbackBoundary(boundary) {
      fallbackBoundaries.push(boundary);
      const fromIdentity = resolveAnthropicFallbackModelIdentity(boundary.fromModel);
      const toIdentity = resolveAnthropicFallbackModelIdentity(boundary.toModel);
      if (!fromIdentity || !toIdentity || fromIdentity === toIdentity) {
        pendingProductTransitions = [];
        return;
      }
      const pendingTail = pendingProductTransitions.at(-1);
      const pendingTailIdentity = resolveAnthropicFallbackModelIdentity(
        pendingTail?.toModel ?? null,
      );
      pendingProductTransitions =
        pendingProductTransitions.length === 0 || pendingTailIdentity === fromIdentity
          ? [...pendingProductTransitions, boundary]
          : [boundary];
    },
    observeFallbackContent() {
      if (pendingProductTransitions.length === 0) {
        return;
      }
      confirmedProductTransitions.push(...pendingProductTransitions);
      pendingProductTransitions = [];
    },
    observeTerminalUsage(usage) {
      if (
        !usage ||
        typeof usage !== "object" ||
        Array.isArray(usage) ||
        !Object.hasOwn(usage, "iterations")
      ) {
        return;
      }
      const iterations = (usage as { iterations?: unknown }).iterations;
      terminalFallbackEvidenceObserved ||=
        Array.isArray(iterations) &&
        iterations.some(
          (iteration) =>
            iteration !== null &&
            typeof iteration === "object" &&
            !Array.isArray(iteration) &&
            (iteration as { type?: unknown }).type === "fallback_message",
        );
      terminalUsage = readTerminalFallbackUsage(usage);
    },
    observeSemanticCoverage(reason) {
      semanticCoverageReasons.add(reason);
    },
    completeSuccess() {
      return finalizeTerminal("completed");
    },
    completeFailure(error) {
      return finalizeTerminal(resolveTransportOutcome(error, options?.signal));
    },
    fail(error) {
      if (finalized) {
        return undefined;
      }
      const resolution =
        fallbackBoundaries.length > 0 || terminalUsage !== undefined
          ? reconcileFallback({
              boundaryAuthority: fallbackBoundaryAuthority,
              requestedModel: params.model.id,
              boundaries: fallbackBoundaries,
              confirmedProductTransitions,
              terminalUsage,
            })
          : undefined;
      const hadUnsettledResponse = Boolean(activeAttempt || pendingResponseAttempt);
      const responseCouldContainFallback =
        pendingResponseStatus !== undefined &&
        pendingResponseStatus >= 200 &&
        pendingResponseStatus < 300;
      if (pendingResponseAttempt) {
        const observedTransitions = resolution?.transitions.length
          ? resolution.transitions
          : (resolution?.productTransitions ?? []);
        for (const transition of observedTransitions) {
          if (transition.fromModel && transition.toModel) {
            state.events.observeProviderFallback({
              transport: ANTHROPIC_TRANSPORT,
              fromModel: transition.fromModel,
              toModel: transition.toModel,
            });
          }
        }
      }
      settlePending(resolveTransportOutcome(error, options?.signal));
      if (!hadUnsettledResponse) {
        flushSemanticCoverage();
      }
      const hasFallbackEvidence = fallbackBoundaries.length > 0 || terminalFallbackEvidenceObserved;
      if (responseCouldContainFallback || hasFallbackEvidence) {
        observeFallbackCoverage(hasFallbackEvidence);
      }
      flushSemanticCoverage();
      const endedBeforeFirstDispatch = phaseInvocationCount === 0 && phaseAwaitingSubmission;
      const abortedDuringRetryBackoff =
        completedAttemptAwaitingPotentialRetry && options?.signal?.aborted === true;
      const retryPreflightFailed = retryInvocationAwaitingDispatch;
      if (
        fetchProvenance === "dispatch_attested" &&
        (endedBeforeFirstDispatch || retryPreflightFailed) &&
        !zeroSubmissionObservedForInvocation
      ) {
        zeroSubmissionObservedForInvocation = true;
        state.events.observeZeroSubmission({
          transport: ANTHROPIC_TRANSPORT,
          outcome: options?.signal?.aborted ? "aborted" : "failed",
        });
      }
      if (
        fetchProvenance === "dispatch_attested" &&
        abortedDuringRetryBackoff &&
        !backoffZeroSubmissionObserved
      ) {
        backoffZeroSubmissionObserved = true;
        state.events.observeZeroSubmission({
          transport: ANTHROPIC_TRANSPORT,
          outcome: "aborted",
        });
      }
      finalized = true;
      finalizedResolution = resolution;
      return resolution &&
        (resolution.transitions.length > 0 ||
          resolution.productTransitions.length > 0 ||
          resolution.servingModel)
        ? resolution
        : undefined;
    },
  };
}
