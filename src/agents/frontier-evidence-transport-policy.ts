import type {
  OpenAIResponsesPayloadVariant,
  OpenAIResponsesRequestParams,
} from "@openclaw/ai/internal/openai";
import { OPENAI_SDK_DEFAULT_MAX_RETRIES } from "@openclaw/ai/internal/openai";
import type { Model } from "@openclaw/llm-core";
import { DEFAULT_FETCH_GUARD_MAX_REDIRECTS } from "../infra/net/fetch-guard.js";
import {
  FrontierEvidenceComparableInputBindingError,
  substituteFrontierEvidenceComparableInput,
  type FrontierEvidenceVolatileBindings,
} from "./frontier-evidence-comparable-input.js";
import {
  computeFrontierEvidenceDigest,
  type FrontierEvidencePolicy,
} from "./frontier-evidence-policy.js";
import {
  canonicalFrontierEvidenceJson,
  expectedFrontierEvidenceContextManagement,
  normalizedFrontierEvidenceJson,
} from "./frontier-evidence-transport-normalize.js";

const FRONTIER_EVIDENCE_RECEIPT_VERSION = 1 as const;
const FRONTIER_EVIDENCE_MAX_REQUESTS_PER_LOGICAL_CALL = 2;
const FRONTIER_EVIDENCE_MAX_FETCH_HOPS_PER_ATTEMPT = DEFAULT_FETCH_GUARD_MAX_REDIRECTS + 1;
export const FRONTIER_EVIDENCE_MAX_FETCH_DISPATCHES_PER_LOGICAL_CALL =
  FRONTIER_EVIDENCE_MAX_REQUESTS_PER_LOGICAL_CALL *
  (OPENAI_SDK_DEFAULT_MAX_RETRIES + 1) *
  FRONTIER_EVIDENCE_MAX_FETCH_HOPS_PER_ATTEMPT;
const FRONTIER_EVIDENCE_OBSERVATIONS_PER_LOGICAL_CALL =
  FRONTIER_EVIDENCE_MAX_REQUESTS_PER_LOGICAL_CALL +
  FRONTIER_EVIDENCE_MAX_FETCH_DISPATCHES_PER_LOGICAL_CALL;
type FrontierEvidenceMismatchCode =
  | "agent_id_mismatch"
  | "api_mismatch"
  | "auth_profile_mismatch"
  | "base_url_mismatch"
  | "comparable_input_binding_mismatch"
  | "credential_state_mismatch"
  | "endpoint_fragment_present"
  | "endpoint_origin_mismatch"
  | "endpoint_path_mismatch"
  | "endpoint_query_present"
  | "fallbacks_present"
  | "http_method_mismatch"
  | "local_service_present"
  | "model_mismatch"
  | "observation_conflict"
  | "observation_missing"
  | "observation_truncated"
  | "logical_call_limit"
  | "policy_not_bound"
  | "provider_mismatch"
  | "proxy_present"
  | "request_authored_params_present"
  | "request_control_mismatch"
  | "request_seed_present"
  | "runtime_mismatch"
  | "tls_present"
  | "transport_mismatch";

type FrontierEvidenceObservation = {
  version: typeof FRONTIER_EVIDENCE_RECEIPT_VERSION;
  policySha256: string;
  authBindingId: string;
  credentialState: "frozen_in_memory";
  stage: "request" | "fetch_dispatch" | "fetch_policy";
  payloadVariant: OpenAIResponsesPayloadVariant;
  transport: "responses-sdk";
  ordinal: number;
  logicalCallOrdinal: number;
  requestOrdinal: number;
  physicalDispatchOrdinal?: number;
  outcome: "matched" | "rejected";
  mismatchCode?: FrontierEvidenceMismatchCode;
  providerModelApiRuntimeMatched: boolean;
  requestControlsMatched: boolean;
  endpointMatched?: boolean;
  taskDigest?: string;
  fullInputDigest?: string;
  comparableInputDigest?: string;
  toolSchemaDigest?: string;
};

export type FrontierEvidenceSnapshot = {
  version: typeof FRONTIER_EVIDENCE_RECEIPT_VERSION;
  policySha256: string;
  authBindingId: string;
  credentialState: "frozen_in_memory";
  promptCacheKeyDigest: string;
  valid: boolean;
  logicalCalls: number;
  requestObservations: number;
  fetchDispatchObservations: number;
  payloadVariants: OpenAIResponsesPayloadVariant[];
  callSequences: Array<{
    logicalCallOrdinal: number;
    logicalCallBindingId: string;
    requestCount: number;
    fetchDispatchCount: number;
    payloadVariants: OpenAIResponsesPayloadVariant[];
    requests: Array<{
      requestOrdinal: number;
      payloadVariant: OpenAIResponsesPayloadVariant;
      fetchDispatchCount: number;
      taskDigest: string;
      fullInputDigest: string;
      comparableInputDigest: string;
      toolSchemaDigest: string;
    }>;
  }>;
  mismatchCodes: FrontierEvidenceMismatchCode[];
  truncated?: true;
};

export class FrontierEvidenceMismatchError extends Error {
  readonly code: FrontierEvidenceMismatchCode;

  constructor(code: FrontierEvidenceMismatchCode) {
    super(`frontier evidence guard rejected request (${code})`);
    this.name = "FrontierEvidenceMismatchError";
    this.code = code;
  }
}

type FrontierEvidenceCollector = {
  observe: (
    observation: Omit<
      FrontierEvidenceObservation,
      "ordinal" | "logicalCallOrdinal" | "requestOrdinal" | "physicalDispatchOrdinal"
    >,
  ) => void;
  snapshot: () => FrontierEvidenceSnapshot;
};

export type FrontierEvidenceBinding = {
  policy: FrontierEvidencePolicy;
  collector: FrontierEvidenceCollector;
  beginLogicalCall: (
    bindings: FrontierEvidenceVolatileBindings,
    providerLogicalCallId: string,
  ) => void;
  expectedPromptCacheKey: string;
  taskDigest: string;
  activeVolatileBindings?: FrontierEvidenceVolatileBindings;
  activePayloadVariant?: OpenAIResponsesPayloadVariant;
};

export function createFrontierEvidenceBinding(
  policy: FrontierEvidencePolicy,
  runtime: {
    promptCacheKey: string;
    taskDigest: string;
  },
): FrontierEvidenceBinding {
  const observations: FrontierEvidenceObservation[] = [];
  const mismatchCodes = new Set<FrontierEvidenceMismatchCode>();
  const observedPayloadVariants = new Set<OpenAIResponsesPayloadVariant>();
  const requestFetchDispatchCounts = new Map<string, number>();
  const callPayloadVariants = new Map<number, OpenAIResponsesPayloadVariant[]>();
  const logicalCallBindingIds = new Map<number, string>();
  const observationLimit = policy.maxLogicalCalls * FRONTIER_EVIDENCE_OBSERVATIONS_PER_LOGICAL_CALL;
  let truncated = false;
  let valid = true;
  let logicalCallOrdinal = 0;
  let requestOrdinal = 0;
  let physicalDispatchOrdinal = 0;

  const collector: FrontierEvidenceCollector = {
    observe(observation) {
      if (observations.length >= observationLimit) {
        truncated = true;
        valid = false;
        mismatchCodes.add("observation_truncated");
        throw new FrontierEvidenceMismatchError("observation_truncated");
      }
      if (logicalCallOrdinal === 0) {
        valid = false;
        mismatchCodes.add("observation_missing");
        throw new FrontierEvidenceMismatchError("observation_missing");
      }
      const next = {
        ...observation,
        ordinal: observations.length + 1,
        logicalCallOrdinal,
        requestOrdinal:
          observation.stage === "request" ? requestOrdinal + 1 : Math.max(requestOrdinal, 1),
        ...(observation.stage === "fetch_dispatch"
          ? { physicalDispatchOrdinal: physicalDispatchOrdinal + 1 }
          : {}),
      };
      if (next.stage === "request") {
        const payloadVariants = callPayloadVariants.get(logicalCallOrdinal) ?? [];
        const priorRequestKey = `${logicalCallOrdinal}:${requestOrdinal}`;
        const expectedVariant =
          payloadVariants.length === 0
            ? "initial"
            : payloadVariants.length === 1 &&
                payloadVariants[0] === "initial" &&
                (requestFetchDispatchCounts.get(priorRequestKey) ?? 0) > 0
              ? "encrypted-content-retry"
              : undefined;
        if (next.payloadVariant !== expectedVariant) {
          valid = false;
          mismatchCodes.add("observation_conflict");
          observations.push({
            ...next,
            outcome: "rejected",
            mismatchCode: "observation_conflict",
          });
          throw new FrontierEvidenceMismatchError("observation_conflict");
        }
        requestOrdinal += 1;
        physicalDispatchOrdinal = 0;
        payloadVariants.push(next.payloadVariant);
        callPayloadVariants.set(logicalCallOrdinal, payloadVariants);
        observedPayloadVariants.add(next.payloadVariant);
        requestFetchDispatchCounts.set(`${logicalCallOrdinal}:${requestOrdinal}`, 0);
      } else if (
        requestOrdinal === 0 ||
        callPayloadVariants.get(logicalCallOrdinal)?.[requestOrdinal - 1] !== next.payloadVariant
      ) {
        valid = false;
        mismatchCodes.add("observation_missing");
        observations.push({
          ...next,
          outcome: "rejected",
          mismatchCode: "observation_missing",
        });
        throw new FrontierEvidenceMismatchError("observation_missing");
      } else if (next.stage === "fetch_dispatch") {
        physicalDispatchOrdinal += 1;
        const requestKey = `${logicalCallOrdinal}:${requestOrdinal}`;
        requestFetchDispatchCounts.set(
          requestKey,
          (requestFetchDispatchCounts.get(requestKey) ?? 0) + 1,
        );
      }
      if (next.outcome === "rejected") {
        valid = false;
        if (next.mismatchCode) {
          mismatchCodes.add(next.mismatchCode);
        }
      }
      observations.push(next);
    },
    snapshot() {
      const payloadVariants = [...observedPayloadVariants].toSorted();
      const requestObservations = observations.filter((entry) => entry.stage === "request").length;
      const fetchDispatchObservations = observations.filter(
        (entry) => entry.stage === "fetch_dispatch",
      ).length;
      const callSequences = Array.from({ length: logicalCallOrdinal }, (_, index) => index + 1).map(
        (ordinal) => {
          const callObservations = observations.filter(
            (entry) => entry.logicalCallOrdinal === ordinal,
          );
          const requests = callObservations
            .filter((entry) => entry.stage === "request")
            .map((entry) => ({
              requestOrdinal: entry.requestOrdinal,
              payloadVariant: entry.payloadVariant,
              fetchDispatchCount:
                requestFetchDispatchCounts.get(
                  `${entry.logicalCallOrdinal}:${entry.requestOrdinal}`,
                ) ?? 0,
              taskDigest: entry.taskDigest ?? "",
              fullInputDigest: entry.fullInputDigest ?? "",
              comparableInputDigest: entry.comparableInputDigest ?? "",
              toolSchemaDigest: entry.toolSchemaDigest ?? "",
            }));
          return {
            logicalCallOrdinal: ordinal,
            logicalCallBindingId: logicalCallBindingIds.get(ordinal) ?? "",
            requestCount: requests.length,
            fetchDispatchCount: requests.reduce(
              (total, request) => total + request.fetchDispatchCount,
              0,
            ),
            payloadVariants: requests.map((request) => request.payloadVariant),
            requests,
          };
        },
      );
      const missingTerminalObservation =
        logicalCallOrdinal === 0 ||
        callSequences.some(
          (sequence) =>
            !/^[a-f0-9]{64}$/u.test(sequence.logicalCallBindingId) ||
            sequence.requestCount === 0 ||
            sequence.requests.some(
              (request) =>
                !/^[a-f0-9]{64}$/u.test(request.taskDigest) ||
                !/^[a-f0-9]{64}$/u.test(request.fullInputDigest) ||
                !/^[a-f0-9]{64}$/u.test(request.comparableInputDigest) ||
                !/^[a-f0-9]{64}$/u.test(request.toolSchemaDigest),
            ) ||
            Array.from({ length: sequence.requestCount }, (_, index) => index + 1).some(
              (ordinal) =>
                (requestFetchDispatchCounts.get(`${sequence.logicalCallOrdinal}:${ordinal}`) ??
                  0) === 0,
            ),
        );
      const snapshotMismatchCodes = new Set(mismatchCodes);
      const hasFetchPolicyRejection = observations.some(
        (observation) => observation.stage === "fetch_policy" && observation.outcome === "rejected",
      );
      const unexplainedMissingTerminalObservation =
        missingTerminalObservation && !hasFetchPolicyRejection;
      if (unexplainedMissingTerminalObservation) {
        snapshotMismatchCodes.add("observation_missing");
      }
      return {
        version: FRONTIER_EVIDENCE_RECEIPT_VERSION,
        policySha256: policy.policySha256,
        authBindingId: policy.authBindingId,
        credentialState: policy.credentialState,
        promptCacheKeyDigest: computeFrontierEvidenceDigest(
          policy.contentDigestKey,
          "prompt-cache-key",
          runtime.promptCacheKey,
        ),
        valid: valid && !unexplainedMissingTerminalObservation,
        logicalCalls: logicalCallOrdinal,
        requestObservations,
        fetchDispatchObservations,
        payloadVariants,
        callSequences,
        mismatchCodes: [...snapshotMismatchCodes].toSorted(),
        ...(truncated ? { truncated: true as const } : {}),
      };
    },
  };
  const binding: FrontierEvidenceBinding = {
    policy,
    collector,
    expectedPromptCacheKey: runtime.promptCacheKey,
    taskDigest: runtime.taskDigest,
    beginLogicalCall(bindings, providerLogicalCallId) {
      if (
        logicalCallOrdinal > 0 &&
        (requestOrdinal === 0 ||
          Array.from({ length: requestOrdinal }, (_, index) => index + 1).some(
            (ordinal) =>
              (requestFetchDispatchCounts.get(`${logicalCallOrdinal}:${ordinal}`) ?? 0) === 0,
          ))
      ) {
        valid = false;
        mismatchCodes.add("observation_missing");
        throw new FrontierEvidenceMismatchError("observation_missing");
      }
      if (logicalCallOrdinal >= policy.maxLogicalCalls) {
        valid = false;
        mismatchCodes.add("logical_call_limit");
        throw new FrontierEvidenceMismatchError("logical_call_limit");
      }
      const values = Object.values(bindings);
      const normalizedLogicalCallId = providerLogicalCallId.trim();
      const logicalCallBindingId = normalizedLogicalCallId
        ? computeFrontierEvidenceDigest(
            policy.contentDigestKey,
            "logical-call",
            normalizedLogicalCallId,
          )
        : "";
      if (
        values.some((value) => !value) ||
        new Set(values).size !== values.length ||
        !logicalCallBindingId ||
        [...logicalCallBindingIds.values()].includes(logicalCallBindingId)
      ) {
        valid = false;
        mismatchCodes.add("comparable_input_binding_mismatch");
        throw new FrontierEvidenceMismatchError("comparable_input_binding_mismatch");
      }
      logicalCallOrdinal += 1;
      logicalCallBindingIds.set(logicalCallOrdinal, logicalCallBindingId);
      requestOrdinal = 0;
      physicalDispatchOrdinal = 0;
      binding.activeVolatileBindings = bindings;
      binding.activePayloadVariant = undefined;
    },
  };
  return binding;
}

function observeRejected(
  binding: FrontierEvidenceBinding,
  params: {
    stage: FrontierEvidenceObservation["stage"];
    payloadVariant: OpenAIResponsesPayloadVariant;
    code: FrontierEvidenceMismatchCode;
    providerModelApiRuntimeMatched: boolean;
    requestControlsMatched: boolean;
    endpointMatched?: boolean;
  },
): never {
  try {
    binding.collector.observe({
      version: FRONTIER_EVIDENCE_RECEIPT_VERSION,
      policySha256: binding.policy.policySha256,
      authBindingId: binding.policy.authBindingId,
      credentialState: binding.policy.credentialState,
      stage: params.stage,
      payloadVariant: params.payloadVariant,
      transport: "responses-sdk",
      outcome: "rejected",
      mismatchCode: params.code,
      providerModelApiRuntimeMatched: params.providerModelApiRuntimeMatched,
      requestControlsMatched: params.requestControlsMatched,
      ...(params.endpointMatched === undefined ? {} : { endpointMatched: params.endpointMatched }),
    });
  } catch (error) {
    if (error instanceof FrontierEvidenceMismatchError && error.code !== params.code) {
      throw error;
    }
  }
  throw new FrontierEvidenceMismatchError(params.code);
}

function hasOwn(record: object, key: string): boolean {
  return Object.hasOwn(record, key);
}

const ALLOWED_REQUEST_KEYS = new Set([
  "context_management",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "metadata",
  "model",
  "parallel_tool_calls",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "store",
  "stream",
  "text",
  "tool_choice",
  "tools",
]);

function hasUnexpectedRequestKey(request: Record<string, unknown>): boolean {
  return Object.keys(request).some((key) => !ALLOWED_REQUEST_KEYS.has(key));
}

function expectedPolicyValue<T>(value: T | "absent"): T | undefined {
  return value === "absent" ? undefined : value;
}

function metadataMatchesPolicy(metadata: unknown, policy: FrontierEvidencePolicy): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (
    normalizedFrontierEvidenceJson(keys) !==
    normalizedFrontierEvidenceJson(policy.expectedMetadata.keys)
  ) {
    return false;
  }
  if (keys.some((key) => typeof record[key] !== "string" || !record[key])) {
    return false;
  }
  return record.openclaw_transport === "stream" && record.openclaw_turn_attempt === "1";
}

export function assertFrontierEvidenceRequest(params: {
  binding: FrontierEvidenceBinding;
  model: Model;
  request: OpenAIResponsesRequestParams;
  payloadVariant: OpenAIResponsesPayloadVariant;
}): void {
  const { binding, model, request, payloadVariant } = params;
  const policy = binding.policy;
  const routeMatches =
    model.provider === policy.provider &&
    model.id === policy.model &&
    model.api === policy.api &&
    model.baseUrl === policy.baseUrl &&
    request.model === policy.model;
  if (!routeMatches) {
    const code: FrontierEvidenceMismatchCode =
      model.provider !== policy.provider
        ? "provider_mismatch"
        : model.id !== policy.model || request.model !== policy.model
          ? "model_mismatch"
          : model.api !== policy.api
            ? "api_mismatch"
            : "base_url_mismatch";
    observeRejected(binding, {
      stage: "request",
      payloadVariant,
      code,
      providerModelApiRuntimeMatched: false,
      requestControlsMatched: true,
    });
  }
  const requestRecord = request as Record<string, unknown>;
  if (hasOwn(requestRecord, "seed") && requestRecord.seed !== undefined) {
    observeRejected(binding, {
      stage: "request",
      payloadVariant,
      code: "request_seed_present",
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: false,
    });
  }
  if (hasUnexpectedRequestKey(requestRecord)) {
    observeRejected(binding, {
      stage: "request",
      payloadVariant,
      code: "request_authored_params_present",
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: false,
    });
  }
  if (request.max_output_tokens !== model.maxTokens) {
    observeRejected(binding, {
      stage: "request",
      payloadVariant,
      code: "request_authored_params_present",
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: false,
    });
  }
  if (
    requestRecord.stream !== true ||
    requestRecord.parallel_tool_calls !== true ||
    normalizedFrontierEvidenceJson(requestRecord.text) !==
      normalizedFrontierEvidenceJson({ verbosity: "low" }) ||
    requestRecord.store !== true ||
    normalizedFrontierEvidenceJson(requestRecord.context_management) !==
      normalizedFrontierEvidenceJson(expectedFrontierEvidenceContextManagement(model)) ||
    normalizedFrontierEvidenceJson(request.reasoning) !==
      normalizedFrontierEvidenceJson(expectedPolicyValue(policy.expectedReasoning)) ||
    normalizedFrontierEvidenceJson(request.include) !==
      normalizedFrontierEvidenceJson(expectedPolicyValue(policy.expectedInclude)) ||
    !metadataMatchesPolicy(request.metadata, policy) ||
    request.tool_choice !== undefined ||
    request.prompt_cache_key !== binding.expectedPromptCacheKey ||
    request.prompt_cache_retention !== undefined
  ) {
    observeRejected(binding, {
      stage: "request",
      payloadVariant,
      code: "request_control_mismatch",
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: false,
    });
  }
  const toolSchemaDigest = computeFrontierEvidenceDigest(
    policy.contentDigestKey,
    "tool-schema",
    canonicalFrontierEvidenceJson(request.tools ?? []),
  );
  const volatileBindings = binding.activeVolatileBindings;
  if (!volatileBindings) {
    observeRejected(binding, {
      stage: "request",
      payloadVariant,
      code: "comparable_input_binding_mismatch",
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: true,
    });
  }
  let comparableInput: unknown;
  try {
    comparableInput = substituteFrontierEvidenceComparableInput(
      {
        instructions: request.instructions ?? null,
        input: request.input,
      },
      volatileBindings,
    );
  } catch (error) {
    if (error instanceof FrontierEvidenceComparableInputBindingError) {
      observeRejected(binding, {
        stage: "request",
        payloadVariant,
        code: "comparable_input_binding_mismatch",
        providerModelApiRuntimeMatched: true,
        requestControlsMatched: true,
      });
    }
    throw error;
  }
  binding.collector.observe({
    version: FRONTIER_EVIDENCE_RECEIPT_VERSION,
    policySha256: policy.policySha256,
    authBindingId: policy.authBindingId,
    credentialState: policy.credentialState,
    stage: "request",
    payloadVariant,
    transport: "responses-sdk",
    outcome: "matched",
    providerModelApiRuntimeMatched: true,
    requestControlsMatched: true,
    taskDigest: binding.taskDigest,
    fullInputDigest: computeFrontierEvidenceDigest(
      policy.contentDigestKey,
      "full-input",
      canonicalFrontierEvidenceJson({
        instructions: request.instructions ?? null,
        input: request.input,
      }),
    ),
    comparableInputDigest: computeFrontierEvidenceDigest(
      policy.contentDigestKey,
      "comparable-input",
      canonicalFrontierEvidenceJson(comparableInput),
    ),
    toolSchemaDigest,
  });
  binding.activePayloadVariant = payloadVariant;
}

export function assertFrontierEvidenceRetryPolicy(
  binding: FrontierEvidenceBinding,
  maxRetries: number | undefined,
): void {
  if ((maxRetries ?? 2) === binding.policy.expectedMaxRetries) {
    return;
  }
  observeRejected(binding, {
    stage: "request",
    payloadVariant: "initial",
    code: "request_control_mismatch",
    providerModelApiRuntimeMatched: true,
    requestControlsMatched: false,
  });
}

function validateFrontierEvidenceFetchDispatch(params: {
  binding: FrontierEvidenceBinding;
  url: string;
  method: string;
}): OpenAIResponsesPayloadVariant {
  const { binding } = params;
  const payloadVariant = binding.activePayloadVariant;
  if (!payloadVariant) {
    throw new FrontierEvidenceMismatchError("observation_missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    observeRejected(binding, {
      stage: "fetch_policy",
      payloadVariant,
      code: "endpoint_origin_mismatch",
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: true,
      endpointMatched: false,
    });
  }
  const policy = binding.policy;
  const code =
    parsed.origin !== policy.endpoint.origin
      ? "endpoint_origin_mismatch"
      : parsed.pathname !== policy.endpoint.pathname
        ? "endpoint_path_mismatch"
        : parsed.search
          ? "endpoint_query_present"
          : parsed.hash
            ? "endpoint_fragment_present"
            : params.method.toUpperCase() !== policy.endpoint.method
              ? "http_method_mismatch"
              : undefined;
  if (code) {
    observeRejected(binding, {
      stage: "fetch_policy",
      payloadVariant,
      code,
      providerModelApiRuntimeMatched: true,
      requestControlsMatched: true,
      endpointMatched: false,
    });
  }
  return payloadVariant;
}

export function assertFrontierEvidenceFetchDispatchPolicy(params: {
  binding: FrontierEvidenceBinding;
  url: string;
  method: string;
}): void {
  validateFrontierEvidenceFetchDispatch(params);
}

export function observeFrontierEvidenceFetchDispatch(params: {
  binding: FrontierEvidenceBinding;
  url: string;
  method: string;
}): void {
  const payloadVariant = validateFrontierEvidenceFetchDispatch(params);
  const { binding } = params;
  const policy = binding.policy;
  binding.collector.observe({
    version: FRONTIER_EVIDENCE_RECEIPT_VERSION,
    policySha256: policy.policySha256,
    authBindingId: policy.authBindingId,
    credentialState: policy.credentialState,
    stage: "fetch_dispatch",
    payloadVariant,
    transport: "responses-sdk",
    outcome: "matched",
    providerModelApiRuntimeMatched: true,
    requestControlsMatched: true,
    endpointMatched: true,
  });
}
