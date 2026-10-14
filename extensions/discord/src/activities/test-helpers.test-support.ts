import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { DiscordActivitiesRuntime } from "./runtime.js";
import { DiscordActivityStore } from "./store.js";

type DiscordActivityWidget = NonNullable<Awaited<ReturnType<DiscordActivityStore["lookupWidget"]>>>;
type DiscordActivitySession = NonNullable<
  Awaited<ReturnType<DiscordActivityStore["lookupSession"]>>
>;
type DiscordActivityDocToken = NonNullable<
  Awaited<ReturnType<DiscordActivityStore["consumeDocToken"]>>
>;
type DiscordActivityPendingLaunch =
  | NonNullable<Awaited<ReturnType<DiscordActivityStore["consumePendingLaunch"]>>>
  | { state: "ambiguous"; createdAt: number };
type DiscordActivityStores = ConstructorParameters<typeof DiscordActivityStore>[0];

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
    async observe(key) {
      return observe(key);
    },
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
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.values()];
    },
    async clear() {
      values.clear();
    },
  };
}

function createMemoryActivityStore(): DiscordActivityStore {
  const stores: DiscordActivityStores = {
    widgets: createMemoryKeyedStore<DiscordActivityWidget>(),
    sessions: createMemoryKeyedStore<DiscordActivitySession>(),
    docTokens: createMemoryKeyedStore<DiscordActivityDocToken>(),
    launches: createMemoryKeyedStore<DiscordActivityPendingLaunch>(),
  };
  return new DiscordActivityStore(stores);
}

export function createActivityTestConfig(params?: {
  userId?: string;
  clientSecret?: string;
  applicationId?: string;
}): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "testtok",
        allowFrom: [params?.userId ?? "42"],
        activities: {
          ...(params?.clientSecret === undefined
            ? { clientSecret: "testsec" }
            : params.clientSecret
              ? { clientSecret: params.clientSecret }
              : {}),
          applicationId: params?.applicationId ?? "123456789012345678",
        },
      },
    },
  };
}

export function createActivityTestRuntime(
  cfg = createActivityTestConfig(),
  env: NodeJS.ProcessEnv = {},
): DiscordActivitiesRuntime {
  return new DiscordActivitiesRuntime(createMemoryActivityStore(), cfg, undefined, env);
}
