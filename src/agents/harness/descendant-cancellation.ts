import { captureAgentHarnessLifecycleHooks } from "./registry-lifecycle.js";
import type { AgentHarness, AgentHarnessDescendantCancellationResult } from "./types.js";

type CancellationParams = Parameters<NonNullable<AgentHarness["withDescendantCancellation"]>>[0];

/** Capture the registered owners before parent cancellation can release its runtime scope. */
export async function withAgentHarnessDescendantCancellation<T>(
  params: CancellationParams,
  run: (cancel: () => Promise<AgentHarnessDescendantCancellationResult>) => Promise<T>,
): Promise<T> {
  const owners = captureAgentHarnessLifecycleHooks("withDescendantCancellation");
  const cancellations: Array<() => Promise<AgentHarnessDescendantCancellationResult>> = [];
  const prepareNext = async (index: number): Promise<T> => {
    const owner = owners[index];
    if (!owner) {
      let called = false;
      return run(async () => {
        if (called) {
          throw new Error("Descendant cancellation was already consumed");
        }
        called = true;
        const results = await Promise.allSettled(cancellations.map((cancel) => cancel()));
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [...(result.value.errors ?? [])],
        );
        try {
          params.assertCurrent();
        } catch (error) {
          errors.push(error);
        }
        return results.reduce<AgentHarnessDescendantCancellationResult>(
          (total, result) => {
            if (result.status === "fulfilled") {
              total.killed += result.value.killed;
              total.cancelledRequesters.push(...result.value.cancelledRequesters);
            }
            return total;
          },
          { killed: 0, cancelledRequesters: [], ...(errors.length ? { errors } : {}) },
        );
      });
    }
    let active = true;
    const assertCurrent = () => {
      params.assertCurrent();
      if (!active || !owner.isCurrent()) {
        throw new Error("Descendant cancellation harness owner changed");
      }
    };
    try {
      assertCurrent();
      const result = await owner.prepare({ ...params, assertCurrent }, async (cancel) => {
        assertCurrent();
        cancellations.push(async () => {
          assertCurrent();
          const count = await cancel();
          try {
            assertCurrent();
          } catch (error) {
            return { ...count, errors: [...(count.errors ?? []), error] };
          }
          return count;
        });
        return prepareNext(index + 1);
      });
      assertCurrent();
      return result;
    } finally {
      active = false;
    }
  };
  return prepareNext(0);
}
