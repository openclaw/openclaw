import { isProxy } from "node:util/types";
import { modelRequestBodyState, responsesPromptObserver } from "@openclaw/ai/internal/openai";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { prepareProviderPrompt, type ProviderPromptTask } from "./provider-prompt-serialization.js";

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

const promptHashPool = resolveGlobalSingleton(
  Symbol.for("openclaw.providerPromptHashPool"),
  () =>
    new WorkerTaskPool<ProviderPromptTask, ReturnType<typeof prepareProviderPrompt>>({
      workerUrl: resolveRuntimeProcessEntrypointUrl("providerPromptState"),
      workerClass: "compute",
      sharedCompute: true,
    }),
);

// onPayload accepts arbitrary hook values. Only ordinary data retains exactly the
// same stable identity across a structured clone; getters and custom objects stay local.
function providerPromptWorkerBytes(
  value: unknown,
  seen = new WeakSet<object>(),
): number | undefined {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      return undefined;
    }
    return typeof value === "string" ? value.length * 2 : 8;
  }
  if (isProxy(value) || "toJSON" in value) {
    return undefined;
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array && (prototype !== Array.prototype || Object.hasOwn(value, Symbol.iterator))) ||
    (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    return undefined;
  }
  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);
  const keys = Object.keys(value);
  if (array && keys.length !== value.length) {
    return undefined;
  }
  let bytes = 64;
  for (const [index, key] of keys.entries()) {
    if (array && key !== String(index)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    const childBytes =
      "value" in descriptor ? providerPromptWorkerBytes(descriptor.value, seen) : undefined;
    if (childBytes === undefined) {
      return undefined;
    }
    // Count UTF-16 strings and container overhead without scanning prompt text.
    bytes += key.length * 2 + 16 + childBytes;
  }
  return bytes;
}

/** Captures the final provider request identity without retaining payload content. */
async function recordProviderPrompt(params: {
  state: ProviderPromptState;
  model: Model;
  payload: unknown;
  signal?: AbortSignal;
  effectiveContextTokenBudget: number;
  encode?: boolean;
}) {
  const scope = stableStringify({
    provider: params.model.provider,
    api: params.model.api,
    model: params.model.id,
    baseUrl: params.model.baseUrl,
    effectiveContextTokenBudget: params.effectiveContextTokenBudget,
  });
  // Retry admission needs exact content equality, including hook replacements and
  // edits to earlier messages. The shared compute pool owns the full traversal.
  const inputBytes = providerPromptWorkerBytes(params.payload);
  const task = { payload: params.payload, encode: params.encode === true };
  const payload =
    inputBytes !== undefined
      ? await promptHashPool
          .run(() => task, { inputBytes, signal: params.signal })
          .catch((error: unknown) => {
            if (params.signal?.aborted) {
              throw error;
            }
            // Bookkeeping worker failure must not make an otherwise valid model call unavailable.
            return prepareProviderPrompt(task);
          })
      : prepareProviderPrompt(task);
  const snapshot = {
    scopeDigest: sha256Hex(scope),
    digest: payload.digest,
    byteWeight: payload.byteWeight,
  };
  const rejected = params.state.lastRejected;
  if (rejected?.scopeDigest === snapshot.scopeDigest && rejected.digest === snapshot.digest) {
    throw new Error(
      "Context overflow: refusing to resend the byte-identical provider payload after a " +
        `context rejection (payloadBytes=${snapshot.byteWeight}).`,
    );
  }
  params.state.lastAttempt = snapshot;
  return payload.encoded;
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

/** Hashes the post-onPayload body for context-retry admission. */
export function wrapStreamFnWithProviderPromptState(params: {
  streamFn: StreamFn;
  state: ProviderPromptState;
  effectiveContextTokenBudget: number;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
}): StreamFn {
  return async (model, context, options) => {
    params.state.lastAttempt = undefined; // Custom transports must not leave a stale candidate.
    const originalOnPayload = options?.onPayload;
    const observedOptions: NonNullable<Parameters<StreamFn>[2]> = {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        if (modelRequestBodyState(observedOptions).enabled) {
          return finalPayload;
        }
        await recordProviderPrompt({
          state: params.state,
          model: payloadModel,
          payload: finalPayload,
          signal: options?.signal,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        });
        return finalPayload;
      },
    };
    modelRequestBodyState(observedOptions).encode = async (payload) => {
      const encoded = await recordProviderPrompt({
        state: params.state,
        model,
        payload,
        signal: options?.signal,
        effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        encode: true,
      });
      return encoded!;
    };
    if (params.recordEvent) {
      responsesPromptObserver.set(observedOptions, (observation) =>
        params.recordEvent?.("provider.prompt.observed", { ...observation }),
      );
    }
    return params.streamFn(model, context, observedOptions);
  };
}
