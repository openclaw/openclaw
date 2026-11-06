import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadPluginInstanceForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll } from "vitest";

type LoadedPlugin = Awaited<ReturnType<typeof loadPluginInstanceForTest>>;

function isClass(value: unknown): boolean {
  return typeof value === "function" && Function.prototype.toString.call(value).startsWith("class");
}

/**
 * Loads the bundled skill-workshop plugin through the real loader once per test file. Workshop
 * code authors skills through the host, which requires the plugin's own call scope; `run` and
 * `scoped` enter it the way the host enters it for tools, hooks, commands and services.
 */
export function useWorkshopPluginScope() {
  let plugin: LoadedPlugin | undefined;
  beforeAll(async () => {
    plugin = await loadPluginInstanceForTest({
      // Vitest runs with plugins off by default; enable only this one.
      config: { plugins: { enabled: true, allow: ["skill-workshop"] } },
      pluginId: "skill-workshop",
    });
  });
  afterAll(async () => {
    await plugin?.dispose();
    plugin = undefined;
  });
  const run = <T>(fn: () => T): T => {
    if (!plugin) {
      throw new Error("skill-workshop plugin scope is not loaded yet");
    }
    return plugin.run(fn);
  };
  /** The module's functions, each entering the plugin scope; classes and values pass through. */
  const scoped = <T extends object>(module: T): T => {
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(module)) {
      wrapped[key] =
        typeof value === "function" && !isClass(value)
          ? (...args: unknown[]) => run(() => (value as (...a: unknown[]) => unknown)(...args))
          : value;
    }
    // SAFETY: every function keeps its signature; only its execution scope changes.
    return wrapped as T;
  };
  return { run, scoped };
}

/** Adds Workshop settings at the plugin's own config path, marked as already migrated. */
export function workshopPluginConfig(
  settings: Record<string, unknown>,
  base: OpenClawConfig = {},
): OpenClawConfig {
  return {
    ...base,
    plugins: {
      ...base.plugins,
      entries: { ...base.plugins?.entries, "skill-workshop": { config: settings } },
    },
    meta: { ...base.meta, migrations: { ...base.meta?.migrations, skillWorkshopPlugin: true } },
  };
}
