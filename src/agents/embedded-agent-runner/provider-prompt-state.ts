import { isProxy } from "node:util/types";
import { responsesPromptObserver } from "@openclaw/ai/internal/openai";
import { createNormalizingPayloadHook } from "@openclaw/ai/internal/shared";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex, sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";

type ProviderPromptSnapshot = {
  scopeDigest: string;
  digest: string;
  byteWeight: number;
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
};

const PROVIDER_PROMPT_STATES_KEY = Symbol.for("openclaw.providerPromptStates");
const providerPromptStates = resolveGlobalSingleton(
  PROVIDER_PROMPT_STATES_KEY,
  () => new Map<string, ProviderPromptState>(),
);

/** Returns run-local retry state; restarts and new run ids intentionally have no baseline. */
export function getProviderPromptState(runId: string): ProviderPromptState {
  const state = providerPromptStates.get(runId) ?? {};
  providerPromptStates.set(runId, state);
  return state;
}

export function clearProviderPromptState(runId: string): void {
  providerPromptStates.delete(runId);
}

/** Captures the final provider request identity without retaining payload content. */
function snapshotProviderPrompt(params: {
  model: Model;
  payload: unknown;
  effectiveContextTokenBudget: number;
}): ProviderPromptSnapshot {
  const scope = stableStringify({
    provider: params.model.provider,
    api: params.model.api,
    model: params.model.id,
    baseUrl: params.model.baseUrl,
    effectiveContextTokenBudget: params.effectiveContextTokenBudget,
  });
  const payload = sha256StableValue(params.payload);
  return {
    scopeDigest: sha256Hex(scope),
    digest: payload.digest,
    byteWeight: payload.byteWeight,
  };
}

/** Rejects only an exact replay of the last provider-rejected request body. */
function assertProviderPromptRetryProgress(
  state: ProviderPromptState,
  candidate: ProviderPromptSnapshot,
): void {
  const rejected = state.lastRejected;
  if (rejected?.scopeDigest === candidate.scopeDigest && rejected.digest === candidate.digest) {
    throw new Error(
      "Context overflow: refusing to resend the byte-identical provider payload after a " +
        `context rejection (payloadBytes=${candidate.byteWeight}).`,
    );
  }
}

export function markLastProviderPromptContextRejected(
  state: ProviderPromptState,
): ProviderPromptSnapshot | undefined {
  const attempted = state.lastAttempt;
  if (attempted) {
    state.lastRejected = attempted;
  }
  return attempted;
}

/** Capture without invoking accessors/toJSON or retaining any hook-owned reference. */
function captureContinuationPayload(
  value: unknown,
  normalize: (payload: unknown) => unknown,
): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (input: unknown, depth: number, protectJson: boolean): unknown => {
    if (++nodes > 1_000_000 || depth > 128) {
      throw new Error("Quota continuation provider payload exceeds snapshot bounds");
    }
    if (
      input === null ||
      input === undefined ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      return input;
    }
    if (typeof input !== "object" || isProxy(input) || ancestors.has(input)) {
      throw new Error("Quota continuation requires an acyclic plain-data provider payload");
    }
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    ) {
      throw new Error("Quota continuation cannot snapshot an opaque provider payload");
    }
    ancestors.add(input);
    const output: Record<string, unknown> | unknown[] = array ? [] : {};
    // JSON must not consult a mutable inherited toJSON after admission. A captured
    // own data property of that name (never a function) may replace this shadow.
    if (protectJson) {
      Object.defineProperty(output, "toJSON", { value: undefined, configurable: true });
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === "length") {
        continue;
      }
      const descriptor = typeof key === "string" ? descriptors[key] : undefined;
      if (
        !descriptor?.enumerable ||
        !("value" in descriptor) ||
        (array && !/^(0|[1-9]\d*)$/.test(String(key)))
      ) {
        throw new Error("Quota continuation cannot snapshot accessor or hidden provider state");
      }
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, depth + 1, protectJson),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && Object.keys(output).length !== input.length) {
      throw new Error("Quota continuation cannot snapshot a sparse provider payload");
    }
    ancestors.delete(input);
    return output;
  };
  // Normalize a detached graph, never a hook-owned accessor/reference. Capture
  // once more afterwards: normalization can create new objects, which also need
  // JSON prototype protection before the exact final body is frozen/admitted.
  const normalized = normalize(visit(value, 0, false));
  nodes = 0;
  return freezeJsonSnapshot(visit(normalized, 0, true));
}

/** Hashes the post-onPayload body for context-retry admission. */
export function wrapStreamFnWithProviderPromptState(params: {
  streamFn: StreamFn;
  state: ProviderPromptState;
  effectiveContextTokenBudget: number;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
  assertFinalPayload?: (payload: unknown, api: string) => void;
}): StreamFn {
  return async (model, context, options) => {
    params.state.lastAttempt = undefined; // Custom transports must not leave a stale candidate.
    const originalOnPayload = options?.onPayload;
    const admittedPayloads = params.assertFinalPayload ? new WeakSet<object>() : undefined;
    const observedOptions: NonNullable<Parameters<StreamFn>[2]> = {
      ...options,
      onPayload: createNormalizingPayloadHook(
        async (payload, payloadModel, normalize) => {
          const replacement = await originalOnPayload?.(payload, payloadModel);
          const candidate = replacement === undefined ? payload : replacement;
          // Ordinary retries preserve their existing payload contract. Custody requires
          // the serializer to receive exactly the detached graph admitted below.
          const finalPayload = params.assertFinalPayload
            ? captureContinuationPayload(candidate, normalize)
            : normalize(candidate);
          params.assertFinalPayload?.(finalPayload, payloadModel.api);
          if (admittedPayloads && finalPayload !== null && typeof finalPayload === "object") {
            admittedPayloads.add(finalPayload);
          }
          const snapshot = snapshotProviderPrompt({
            model: payloadModel,
            payload: finalPayload,
            effectiveContextTokenBudget: params.effectiveContextTokenBudget,
          });
          assertProviderPromptRetryProgress(params.state, snapshot);
          params.state.lastAttempt = snapshot;
          return finalPayload;
        },
        admittedPayloads
          ? (payload, payloadModel) => {
              if (
                payload === null ||
                typeof payload !== "object" ||
                !admittedPayloads.has(payload)
              ) {
                throw new Error("Quota continuation transport substituted the admitted payload");
              }
              params.assertFinalPayload?.(payload, payloadModel.api);
            }
          : undefined,
      ),
    };
    if (params.recordEvent) {
      responsesPromptObserver.set(observedOptions, (observation) =>
        params.recordEvent?.("provider.prompt.observed", { ...observation }),
      );
    }
    return params.streamFn(model, context, observedOptions);
  };
}
