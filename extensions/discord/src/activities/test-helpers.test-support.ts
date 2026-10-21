import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { DiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";

export function createMemoryKeyedStore<T>(): PluginStateKeyedStore<T> & {
  observe: NonNullable<PluginStateKeyedStore<T>["observe"]>;
  compareAndApply: NonNullable<PluginStateKeyedStore<T>["compareAndApply"]>;
} {
  const values = new Map<string, PluginStateEntry<T>>();
  const observe = (key: string) => ({
    value: structuredClone(values.get(key)?.value),
    comparison: JSON.stringify(values.get(key)) ?? "missing",
  });
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    observe: async (key) => observe(key),
    async compareAndApply(key, comparison, intent) {
      const current = observe(key);
      if (comparison !== current.comparison) {
        return { status: "conflict", current };
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action === "delete") {
        return { status: values.delete(key) ? "applied" : "unchanged" };
      }
      values.set(key, { key, value: structuredClone(intent.value), createdAt: Date.now() });
      return { status: "applied" };
    },
    lookup: async (key) => values.get(key)?.value,
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    entries: async () => [...values.values()],
    clear: async () => {
      values.clear();
    },
  };
}

export function createActivityTestConfig({
  userId = "42",
  clientSecret = "testsec",
  applicationId = "123456789012345678",
}: {
  userId?: string;
  clientSecret?: string;
  applicationId?: string;
} = {}): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "testtok",
        allowFrom: [userId],
        activities: {
          ...(clientSecret ? { clientSecret } : {}),
          applicationId,
        },
      },
    },
  };
}

export function createActivityTestRuntime(
  cfg = createActivityTestConfig(),
): DiscordActivitiesRuntime {
  const store = new DiscordActivityStore(openDiscordActivityStores(createMemoryKeyedStore));
  return new DiscordActivitiesRuntime(store, () => cfg, {});
}
