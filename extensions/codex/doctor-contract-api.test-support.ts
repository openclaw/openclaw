import { createPluginStateKeyedStoreV2ForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

export function createDoctorContext(
  env: NodeJS.ProcessEnv,
  afterRegister?: () => Promise<void>,
  beforeCompare?: (key: string) => Promise<void>,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreV2ForTests<T>(
        "codex",
        { ...options, env: options.env ?? env },
        { assertCurrent() {} },
      );
      return afterRegister || beforeCompare
        ? {
            ...store,
            async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
              const registered = await store.registerIfAbsent(...args);
              await afterRegister?.();
              return registered;
            },
            async compareAndApply(...args: Parameters<typeof store.compareAndApply>) {
              await beforeCompare?.(args[0]);
              return await store.compareAndApply(...args);
            },
          }
        : store;
    },
  };
}
