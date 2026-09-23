import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type { ModelRef } from "./model-ref-shared.js";

/** A completion keeps its selected-model fence through the runtime's physical cleanup. */
export function createIsolatedCompletionModelAuthority(params: {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  mapOperatorAuthorizationError?: (error: unknown) => Error;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  runtime: AsyncDisposable;
}) {
  const resources = new AsyncDisposableStack();
  let bound:
    | {
        model: ModelRef | undefined;
        execution: NonNullable<ReturnType<typeof bindOperatorModelExecution>>;
      }
    | undefined;
  return {
    bind(model: ModelRef | undefined): { abortSignal?: AbortSignal; assertCurrent?: () => void } {
      params.assertCurrent();
      if (
        !bound ||
        bound.model?.provider !== model?.provider ||
        bound.model?.model !== model?.model
      ) {
        let execution: ReturnType<typeof bindOperatorModelExecution>;
        try {
          execution = bindOperatorModelExecution(params.operatorAuthority, model);
        } catch (error) {
          throw params.mapOperatorAuthorizationError?.(error) ?? error;
        }
        if (!execution) {
          return {};
        }
        resources.defer(execution.release);
        bound = { model: model ? { ...model } : undefined, execution };
      }
      const { execution } = bound;
      const assertExecutionCurrent = () => {
        try {
          execution.assertCurrent();
        } catch (error) {
          throw params.mapOperatorAuthorizationError?.(error) ?? error;
        }
      };
      assertExecutionCurrent();
      return {
        abortSignal: params.abortSignal
          ? AbortSignal.any([params.abortSignal, execution.signal])
          : execution.signal,
        assertCurrent: () => {
          params.assertCurrent();
          assertExecutionCurrent();
        },
      };
    },
    async release() {
      try {
        await params.runtime[Symbol.asyncDispose]();
      } finally {
        await resources.disposeAsync();
      }
    },
  };
}
