import {
  bindOperatorModelExecution,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import type { ModelRef } from "./model-ref-shared.js";

/** A completion keeps its selected-model fence through the runtime's physical cleanup. */
export function createIsolatedCompletionModelAuthority(params: {
  operatorAuthority?: AdmittedRunOperatorAuthority;
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
        const execution = bindOperatorModelExecution(params.operatorAuthority, model);
        if (!execution) {
          return {};
        }
        resources.defer(execution.release);
        bound = { model: model ? { ...model } : undefined, execution };
      }
      const { execution } = bound;
      execution.assertCurrent();
      return {
        abortSignal: params.abortSignal
          ? AbortSignal.any([params.abortSignal, execution.signal])
          : execution.signal,
        assertCurrent: () => {
          params.assertCurrent();
          execution.assertCurrent();
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
