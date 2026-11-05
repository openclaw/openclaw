import type {
  NativeSessionBindingLeaseConfig,
  NativeSessionBindingRecord,
  NativeSessionBindingStateStore,
} from "./binding-leases.js";

export type TestBindingRecord = NativeSessionBindingRecord & { value?: string };

export function createBindingTestState() {
  const values = new Map<string, TestBindingRecord>();
  const state: NativeSessionBindingStateStore<TestBindingRecord> = {
    lookup: (key) => values.get(key),
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    withCurrent({ assertCurrent }) {
      const observe = (key: string) => ({
        value: structuredClone(values.get(key)),
        comparison: JSON.stringify(values.get(key) ?? null),
      });
      return {
        async observe(key) {
          assertCurrent();
          return observe(key);
        },
        async compareAndApply(key, comparison, intent) {
          assertCurrent();
          const current = observe(key);
          if (current.comparison !== comparison) {
            return { status: "conflict", current };
          }
          if (intent.action === "set") {
            values.set(key, structuredClone(intent.value));
            return { status: "applied" };
          }
          if (intent.action === "delete") {
            values.delete(key);
            return { status: "applied" };
          }
          return { status: "unchanged" };
        },
      };
    },
    deleteIf(key, predicate) {
      const value = values.get(key);
      return value !== undefined && predicate(value) && values.delete(key);
    },
  };
  return { state, values };
}

export const bindingTestOptions = {
  // The fixture owns these opaque records, without a backend codec or retention policy.
  readRecord: (raw: unknown) => raw as TestBindingRecord | undefined,
  lease: { staleMs: 65_000, waitMs: 70_000, retryIntervalMs: 1_000, renewIntervalMs: 21_666 },
  releaseTtlMs: () => undefined,
  errors: {
    atomicUpdatesRequired: "Binding updates must be atomic",
    invalidRow: (key: string) => new Error(`Invalid binding row: ${key}`),
    lostLease: (key: string) => new Error(`Lost binding lease: ${key}`),
    leaseTimeout: (key: string) => new Error(`Binding lease timed out: ${key}`),
    acquisitionRejected: (key: string) => new Error(`Binding lease rejected: ${key}`),
    mutationBlocked: "Binding mutation blocked while native archive is in progress",
    conditionalDeletionRequired: "Binding deletion must be conditional",
    deletionChanged: "Binding changed before session deletion",
    rollbackChanged: "Binding changed before session deletion rollback",
  },
} satisfies NativeSessionBindingLeaseConfig<TestBindingRecord> & {
  errors: {
    mutationBlocked: string;
    conditionalDeletionRequired: string;
    deletionChanged: string;
    rollbackChanged: string;
  };
};

export function prepareBindingTestLease(
  current: TestBindingRecord | undefined,
  lease: NonNullable<TestBindingRecord["lease"]>,
): TestBindingRecord {
  return { ...current, lease };
}
