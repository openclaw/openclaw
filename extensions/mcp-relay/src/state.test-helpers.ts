import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { RelayState } from "./state.js";

const RELAY = "https://mcp.openclaw.ai";

export function createStateFixture() {
  let serialized: string | undefined;
  let revision = 0;
  let current = true;
  let now = 0;
  const effects: {
    beforeCompare?: () => Promise<void>;
    afterCommit?: () => void;
    failure?: Error;
  } = {};
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Service stopped");
    }
  };
  const unsupported = () => {
    throw new Error("Unexpected SDK operation");
  };
  const unsupportedAsync = async () => unsupported();

  function store<T>(assertion: () => void): PluginStateKeyedStore<T, 2> {
    const lookup = async (): Promise<T | undefined> => {
      assertion();
      if (effects.failure) {
        throw effects.failure;
      }
      return serialized === undefined ? undefined : JSON.parse(serialized);
    };
    return {
      lookup,
      observe: async () => {
        assertion();
        if (effects.failure) {
          throw effects.failure;
        }
        return {
          value: serialized === undefined ? undefined : JSON.parse(serialized),
          comparison: String(revision),
        };
      },
      compareAndApply: async (_key, comparison, intent) => {
        const before = effects.beforeCompare;
        effects.beforeCompare = undefined;
        await before?.();
        assertion();
        if (effects.failure) {
          throw effects.failure;
        }
        if (comparison !== String(revision)) {
          return {
            status: "conflict",
            current: { value: await lookup(), comparison: String(revision) },
          };
        }
        if (intent.action === "keep") {
          return { status: "unchanged" };
        }
        serialized = intent.action === "set" ? JSON.stringify(intent.value) : undefined;
        revision += 1;
        const after = effects.afterCommit;
        effects.afterCommit = undefined;
        after?.();
        return { status: "applied" };
      },
      register: unsupportedAsync,
      registerIfAbsent: unsupportedAsync,
      lookupMany: unsupportedAsync,
      consume: unsupportedAsync,
      delete: unsupportedAsync,
      deleteIfEqual: unsupportedAsync,
      entries: unsupportedAsync,
      entriesInKeyRange: unsupportedAsync,
      moveEntriesFrom: unsupportedAsync,
      count: unsupportedAsync,
      clear: unsupportedAsync,
    };
  }

  const runtime: Pick<PluginRuntime, "state"> = {
    state: {
      resolveStateDir: unsupported,
      openBlobStore: unsupported,
      openSyncKeyedStore: unsupported,
      openChannelIngressQueue: unsupported,
      openChannelIngressDrain: unsupported,
      openKeyedStoreV2: unsupported,
      openKeyedStore: <T>(): PluginStateKeyedStore<T> => ({
        ...store<T>(assertCurrent),
        withCurrent: ({ assertCurrent: assertion }) => store<T>(assertion),
      }),
    },
  };
  return {
    runtime,
    effects,
    setNow: (value: number) => {
      now = value;
    },
    open: (url = RELAY) => new RelayState(runtime, url, assertCurrent, () => now),
    stop: () => {
      current = false;
    },
    corrupt: () => {
      serialized = '{"version":1,"privateKey":"bad"}';
    },
    persisted: () => serialized,
  };
}
