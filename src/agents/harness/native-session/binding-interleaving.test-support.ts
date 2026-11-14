import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { NativeSessionBindingStateStore } from "./binding-leases.js";
import type { TestBindingRecord } from "./binding.test-support.js";

export function bindingMutation(value: string, current?: TestBindingRecord) {
  return { next: { ...current, value }, result: true };
}

export function bindingGate() {
  const entered = createDeferred();
  const resumed = createDeferred();
  let outcome: Promise<unknown> | undefined;
  return {
    reached: entered.promise,
    resume: resumed.resolve,
    async pause() {
      entered.resolve();
      await resumed.promise;
    },
    observe(work: Promise<unknown>) {
      outcome = work.catch((error: unknown) => error);
      return outcome;
    },
    wait(work: Promise<unknown>, message: string) {
      return awaitGateBeforeSettlement(entered.promise, work, message);
    },
    async [Symbol.asyncDispose]() {
      // Failed assertions must release the pause before joining worker cleanup.
      resumed.resolve();
      await outcome;
    },
  };
}

export function interceptBindingStore<TStore extends object>(
  state: {
    withCurrent(
      authority: Parameters<NativeSessionBindingStateStore<TestBindingRecord>["withCurrent"]>[0],
    ): TStore;
  },
  wrap: (store: TStore) => Partial<TStore>,
) {
  const original = state.withCurrent.bind(state);
  state.withCurrent = (authority) => {
    const store = original(authority);
    return { ...store, ...wrap(store) };
  };
  return () => {
    state.withCurrent = original;
  };
}
