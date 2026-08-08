import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AiModelFetchProvenance } from "../host.js";
import {
  createModelTransportAttemptAuthority,
  createModelTransportEventScope,
  type ModelTransportAttemptAuthority,
  type ModelTransportEventScope,
  type ModelTransportOutcome,
} from "./model-transport-accounting-internal.js";

const OPENAI_SDK_TRANSPORT = "responses-sdk";
export const OPENAI_SDK_DEFAULT_MAX_RETRIES = 2;
const openAISdkTransportScopes = new WeakMap<object, OpenAISdkTransportScope>();

type OpenAISdkTransportScope = {
  events: ModelTransportEventScope;
  callerSignal?: AbortSignal;
  maxRetries: number;
  submissionReason: "initial" | "payload_recovery";
  phaseFetchInvocationCount: number;
  phaseAwaitingSubmission: boolean;
  currentFetchDispatched: boolean;
  activeAttempt?: ModelTransportAttemptAuthority;
  pendingResponseAttempt?: ModelTransportAttemptAuthority;
  pendingResponseStatus?: number;
  currentInvocationZeroSubmissionObserved: boolean;
  fetchProvenance?: AiModelFetchProvenance;
};

function shouldRetryResponse(response: Response): boolean {
  const shouldRetryHeader = response.headers.get("x-should-retry");
  if (shouldRetryHeader === "true") {
    return true;
  }
  if (shouldRetryHeader === "false") {
    return false;
  }
  return response.status === 408 || response.status === 409 || response.status === 429
    ? true
    : response.status >= 500;
}

export function createOpenAISdkAccountingFetch(params: {
  model: Model;
  callId?: string;
  scopeId: string;
  callerSignal?: AbortSignal;
  maxRetries?: number;
}): {
  onFetchDispatch: () => void;
  scope: OpenAISdkTransportScope;
  wrapGuardedFetch: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
} {
  const scope: OpenAISdkTransportScope = {
    events: createModelTransportEventScope(params),
    callerSignal: params.callerSignal,
    maxRetries: params.maxRetries ?? OPENAI_SDK_DEFAULT_MAX_RETRIES,
    submissionReason: "initial",
    phaseFetchInvocationCount: 0,
    phaseAwaitingSubmission: true,
    currentFetchDispatched: false,
    currentInvocationZeroSubmissionObserved: false,
  };
  return {
    scope,
    onFetchDispatch() {
      if (scope.fetchProvenance !== "dispatch_attested") {
        return;
      }
      scope.phaseAwaitingSubmission = false;
      scope.currentFetchDispatched = true;
      const pendingAttempt = scope.events.startAttempt({
        transport: OPENAI_SDK_TRANSPORT,
        reason: scope.phaseFetchInvocationCount === 1 ? scope.submissionReason : "retry",
      });
      scope.activeAttempt = createModelTransportAttemptAuthority({
        events: scope.events,
        pendingAttempt,
        requestedModel: params.model.id,
        transport: OPENAI_SDK_TRANSPORT,
      });
    },
    wrapGuardedFetch(fetch) {
      return async (input, init) => {
        scope.phaseFetchInvocationCount += 1;
        scope.phaseAwaitingSubmission = true;
        scope.currentFetchDispatched = false;
        scope.currentInvocationZeroSubmissionObserved = false;
        try {
          const response = await fetch(input, init);
          const pending = scope.activeAttempt;
          scope.activeAttempt = undefined;
          if (pending) {
            pending.observeServingModel(
              response.headers.get("openai-model") ?? response.headers.get("x-openai-model"),
            );
            if (response.ok) {
              scope.pendingResponseAttempt = pending;
              scope.pendingResponseStatus = response.status;
            } else {
              pending.finish("failed", response.status);
            }
          }
          scope.phaseAwaitingSubmission =
            !response.ok &&
            scope.phaseFetchInvocationCount <= scope.maxRetries &&
            shouldRetryResponse(response);
          scope.currentFetchDispatched = false;
          return response;
        } catch (error) {
          const fetchDispatched = scope.currentFetchDispatched;
          const outcome = scope.callerSignal?.aborted ? "aborted" : "failed";
          if (
            scope.fetchProvenance === "dispatch_attested" &&
            !fetchDispatched &&
            !scope.currentInvocationZeroSubmissionObserved
          ) {
            scope.currentInvocationZeroSubmissionObserved = true;
            scope.events.observeZeroSubmission({
              transport: OPENAI_SDK_TRANSPORT,
              outcome,
            });
          }
          scope.activeAttempt?.finish(outcome);
          scope.activeAttempt = undefined;
          scope.pendingResponseAttempt?.finish(outcome, scope.pendingResponseStatus);
          scope.pendingResponseAttempt = undefined;
          scope.pendingResponseStatus = undefined;
          const retryPending =
            !scope.callerSignal?.aborted && scope.phaseFetchInvocationCount <= scope.maxRetries;
          scope.phaseAwaitingSubmission = retryPending;
          if (retryPending) {
            // The failed invocation is accounted above. A backoff abort belongs
            // to the next route phase, which has not submitted yet.
            scope.currentInvocationZeroSubmissionObserved = false;
          }
          scope.currentFetchDispatched = false;
          throw error;
        }
      };
    },
  };
}

export function registerOpenAISdkTransportScope(
  client: object,
  scope: OpenAISdkTransportScope,
): void {
  openAISdkTransportScopes.set(client, scope);
}

export function setOpenAISdkFetchProvenance(
  scope: OpenAISdkTransportScope,
  provenance: AiModelFetchProvenance | undefined,
): void {
  scope.fetchProvenance = provenance;
}

export function markOpenAISdkPayloadRecovery(client: object): void {
  const scope = openAISdkTransportScopes.get(client);
  if (!scope) {
    return;
  }
  scope.submissionReason = "payload_recovery";
  scope.phaseFetchInvocationCount = 0;
  scope.phaseAwaitingSubmission = true;
  scope.currentFetchDispatched = false;
  scope.currentInvocationZeroSubmissionObserved = false;
}

export function finishOpenAISdkTransportScope(
  scope: OpenAISdkTransportScope,
  outcome: ModelTransportOutcome,
  statusCode?: number,
): void {
  const pending = scope?.pendingResponseAttempt;
  if (!pending) {
    return;
  }
  scope.pendingResponseAttempt = undefined;
  const responseStatus = scope.pendingResponseStatus;
  scope.pendingResponseStatus = undefined;
  pending.finish(outcome, statusCode ?? responseStatus);
}

export function observeOpenAISdkServingModel(scope: OpenAISdkTransportScope, event: unknown): void {
  if (
    !isRecord(event) ||
    !(
      event.type === "response.created" ||
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) ||
    !isRecord(event.response)
  ) {
    return;
  }
  scope.pendingResponseAttempt?.observeServingModel(event.response.model);
}

export function failOpenAISdkTransportScope(
  scope: OpenAISdkTransportScope,
  outcome: ModelTransportOutcome,
): void {
  const pending = scope.pendingResponseAttempt;
  scope.pendingResponseAttempt = undefined;
  const responseStatus = scope.pendingResponseStatus;
  scope.pendingResponseStatus = undefined;
  if (pending) {
    pending.finish(outcome, responseStatus);
    return;
  }
  if (
    scope.fetchProvenance === "dispatch_attested" &&
    scope.phaseAwaitingSubmission &&
    !scope.currentInvocationZeroSubmissionObserved
  ) {
    scope.currentInvocationZeroSubmissionObserved = true;
    scope.events.observeZeroSubmission({
      transport: OPENAI_SDK_TRANSPORT,
      outcome: scope.callerSignal?.aborted || outcome === "aborted" ? "aborted" : "failed",
    });
  }
}
