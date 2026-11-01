import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import type { StreamOptions, UserMessage } from "../types.js";
import type { ResponsesContinuationRequest } from "./openai-responses-continuation.js";

type Submission = {
  input: ResponseInput;
  resolve: (accepted: boolean) => void;
  reject: (error: Error) => void;
};

function cloneWireRequest<T>(request: T): T {
  const serialized = JSON.stringify(request);
  // SAFETY: Requests are JSON wire bodies; normalization intentionally runs toJSON.
  return JSON.parse(serialized) as T;
}

export async function projectResponsesSteeringInput<T extends { input?: ResponseInput }>(
  request: T,
  project: () => Promise<T>,
): Promise<ResponseInput> {
  const { input: activeInput, ...activeSettings } = cloneWireRequest(request);
  if (!Array.isArray(activeInput)) {
    return [];
  }
  const { input, ...settings } = cloneWireRequest(await project());
  // Payload hooks and sanitizers own every submitted input. Rewriting the active
  // prefix or settings requires ordinary queued delivery through a new request.
  if (
    !Array.isArray(input) ||
    !isDeepStrictEqual(settings, activeSettings) ||
    !isDeepStrictEqual(input.slice(0, activeInput.length), activeInput)
  ) {
    return [];
  }
  const projected = input.slice(activeInput.length);
  return projected.every((item) => isRecord(item) && item.role === "user") ? projected : [];
}

/** One response owns admission; accepted input stays on this connection until continuation. */
export function createResponsesSteering(params: {
  onActiveResponse: NonNullable<StreamOptions["onActiveResponse"]>;
  toInput: (messages: readonly UserMessage[]) => ResponseInput | Promise<ResponseInput>;
  send: (event: {
    type: "response.steer";
    previous_response_id: string;
    input: ResponseInput;
  }) => void;
  assertActive: () => void;
  needsContinuation?: boolean;
}) {
  const needsContinuation = params.needsContinuation;
  let responseId: string | undefined;
  let active: typeof params | undefined = params;
  let unsubscribe: (() => void) | void;
  const pending: Submission[] = [];
  const accepted = new Map<string, ResponseInput>();
  const acknowledged = new Set<string>();
  const seal = () => {
    // Continuations need acknowledgements, not the completed request's callbacks.
    active = undefined;
    const cleanup = unsubscribe;
    unsubscribe = undefined;
    cleanup?.();
  };
  return {
    get responseId() {
      return responseId;
    },
    get pending() {
      return pending.length > 0;
    },
    get acceptedInput(): ResponseInput {
      return [...accepted.values()].flat();
    },
    seal,
    close(error: Error) {
      seal();
      for (const submission of pending.splice(0)) {
        submission.reject(error);
      }
    },
    handle(event: unknown): boolean {
      if (!isRecord(event)) {
        return false;
      }
      if (event.type === "response.created" && !responseId && active) {
        const response = isRecord(event.response) ? event.response : undefined;
        if (typeof response?.id !== "string" || !response.id.trim()) {
          throw new Error("Responses steering requires a response identity");
        }
        const activeResponseId = response.id;
        responseId = activeResponseId;
        const cleanup = active.onActiveResponse({
          needsContinuation: needsContinuation === undefined ? undefined : () => needsContinuation,
          steer(messages) {
            if (!active || messages.length === 0) {
              return Promise.resolve(false);
            }
            active.assertActive();
            const converted = active.toInput(messages);
            const submit = (input: ResponseInput) => {
              const callbacks = active;
              if (!callbacks || input.length === 0) {
                return Promise.resolve(false);
              }
              callbacks.assertActive();
              return new Promise<boolean>((resolve, reject) => {
                pending.push({ input, resolve, reject });
                // Record before dispatch: a throwing send cannot prove the frame stayed local.
                callbacks.send({
                  type: "response.steer",
                  previous_response_id: activeResponseId,
                  input,
                });
              });
            };
            return Array.isArray(converted) ? submit(converted) : converted.then(submit);
          },
        });
        if (!active) {
          cleanup?.();
        } else {
          unsubscribe = cleanup;
        }
        return false;
      }
      if (
        event.type !== "response.steer.accepted" &&
        event.type !== "response.steer.failed" &&
        event.type !== "response.steer.pending"
      ) {
        return false;
      }
      const steer = isRecord(event.steer) ? event.steer : undefined;
      if (!responseId || steer?.previous_response_id !== responseId) {
        throw new Error("Responses steering acknowledgement has an unexpected identity");
      }
      if (event.type === "response.steer.failed" && steer.id === undefined) {
        // Rejection before ID allocation returns the original input instead.
        // Match it before consuming a submission; a different steer may still be pending.
        const index = pending.findIndex(
          (submission) => stableStringify(submission.input) === stableStringify(steer.input),
        );
        const submission = pending[index];
        if (!submission) {
          throw new Error("Responses steering acknowledgement has no pending submission");
        }
        pending.splice(index, 1);
        submission.resolve(false);
        return true;
      }
      if (typeof steer.id !== "string" || !steer.id.trim()) {
        throw new Error("Responses steering acknowledgement has an unexpected identity");
      }
      if (event.type === "response.steer.pending") {
        if (!accepted.has(steer.id)) {
          throw new Error("Responses steering pending event has no accepted submission");
        }
        return true;
      }
      if (event.type === "response.steer.failed" && accepted.has(steer.id)) {
        throw new Error(
          "OpenAI could not apply accepted steering; the queued message remains in the conversation",
        );
      }
      if (acknowledged.has(steer.id)) {
        throw new Error("Responses steering acknowledgement was already applied");
      }
      const submission = pending.shift();
      if (!submission) {
        throw new Error("Responses steering acknowledgement has no pending submission");
      }
      acknowledged.add(steer.id);
      if (event.type === "response.steer.accepted") {
        accepted.set(steer.id, submission.input);
        submission.resolve(true);
      } else {
        submission.resolve(false);
      }
      return true;
    },
  };
}

/** Accepted steering is prepended by the server, so never repeat it in response.create. */
export function omitAcceptedSteering(
  input: NonNullable<ResponsesContinuationRequest["input"]>,
  accepted: ResponseInput,
): NonNullable<ResponsesContinuationRequest["input"]> {
  const remaining = [...input];
  for (const message of accepted) {
    const index = remaining.findIndex((item) => stableStringify(item) === stableStringify(message));
    if (index < 0) {
      throw new Error("Responses steering continuation no longer contains the accepted user input");
    }
    remaining.splice(index, 1);
  }
  return remaining;
}
