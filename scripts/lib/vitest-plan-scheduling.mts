import { isConstrainedCiCheckHost } from "./local-check-runtime.mts";

export const MAX_CI_VITEST_PLAN_CONCURRENCY = 2;

export function resolveCiVitestPlanConcurrency(
  count: number,
  resources: { logicalCpuCount: number; totalMemoryBytes: number },
  requested = MAX_CI_VITEST_PLAN_CONCURRENCY,
) {
  return Math.min(
    count,
    requested,
    isConstrainedCiCheckHost(resources) ? 1 : MAX_CI_VITEST_PLAN_CONCURRENCY,
  );
}

/** Callers return only after their child and cache lease have settled. */
export async function runVitestPlans<T>(
  plans: readonly T[],
  options: {
    concurrency: number;
    isExclusive?: (plan: T) => boolean;
    shouldStop: () => boolean;
    run: (plan: T, index: number, lane: number) => Promise<void>;
  },
) {
  if (plans.length === 0) {
    return;
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Vitest plan concurrency must be a positive integer");
  }
  let next = 0;
  const errors: unknown[] = [];
  while (next < plans.length && !options.shouldStop()) {
    const first = next;
    const exclusive = options.isExclusive?.(plans[first]!) === true;
    let end = first + 1;
    if (!exclusive) {
      while (end < plans.length && !options.isExclusive?.(plans[end]!)) {
        end += 1;
      }
    }
    // Drain the entire ordinary span before an exclusive plan, and that plan
    // before admitting the next span. Lane identity stays stable across both.
    await Promise.all(
      Array.from(
        { length: Math.min(exclusive ? 1 : options.concurrency, end - first) },
        async (_, lane) => {
          while (next < end && errors.length === 0 && !options.shouldStop()) {
            const index = next++;
            try {
              await options.run(plans[index]!, index, lane);
            } catch (error) {
              errors.push(error);
            }
          }
        },
      ),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, String(errors[0]));
    }
  }
}
