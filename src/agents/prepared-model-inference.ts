import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { AgentHarnessPluginSelection } from "./harness/runtime-plugin-load-plan.js";
import { acquirePreparedSimpleCompletionRuntime } from "./simple-completion-runtime.js";
type PreparedSimpleCompletionResolverContext = Awaited<
  ReturnType<typeof acquirePreparedSimpleCompletionRuntime>
>;

/** Execute a typed task inside the same prepared generation and physical cleanup owner as chat. */
export async function withPreparedModelInference<Result>(
  params: Parameters<typeof acquirePreparedSimpleCompletionRuntime>[0],
  selection: AgentHarnessPluginSelection,
  execute: (context: PreparedSimpleCompletionResolverContext) => Promise<Result>,
): Promise<Result> {
  const failures = new Set<unknown>();
  const work = new AsyncWorkScope(failures);
  const abort = () => work.run(() => work.beginClose(params.signal?.reason));
  params.signal?.addEventListener("abort", abort, { once: true });
  if (params.signal?.aborted) {
    abort();
  }
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => params.signal?.removeEventListener("abort", abort));
  cleanup.defer(async () => {
    await work.drain();
    const failure = failures.values().next();
    if (!failure.done) {
      throw failure.value;
    }
  });
  return await work.run(() =>
    runWithAsyncWorkResources(async (onAcquired, captureWorkContext) => {
      const context = await acquirePreparedSimpleCompletionRuntime(
        params,
        [selection],
        (release) => {
          onAcquired({ release });
        },
      );
      params.signal?.throwIfAborted();
      return withPluginRuntimeGenerationScope(context.preparedModelRuntime, async () => {
        captureWorkContext();
        if (!context.preparedModelRuntime.isCurrent()) {
          throw new Error("Prepared model inference generation is no longer current.");
        }
        const result = await execute(context);
        params.signal?.throwIfAborted();
        if (!context.preparedModelRuntime.isCurrent()) {
          throw new Error("Prepared model inference generation is no longer current.");
        }
        return result;
      });
    }),
  );
}
