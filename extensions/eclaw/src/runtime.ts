/**
 * Plugin runtime store for the E-Claw channel plugin.
 *
 * Holds the `PluginRuntime` instance injected by OpenClaw core when
 * the bundled plugin registers. All extension-side code that needs
 * the runtime (webhook handlers, setup adapters, reply dispatchers)
 * goes through `getEclawRuntime()` / `setEclawRuntime()`.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-overview.md §"Plugin runtime" — every bundled
 *     plugin owns its own runtime store via
 *     `createPluginRuntimeStore<PluginRuntime>(...)` so the module is
 *     import-safe (no top-level throw if the plugin isn't loaded).
 *   - docs/plugins/architecture.md §"Plugin SDK import paths" —
 *     `openclaw/plugin-sdk/core` for `PluginRuntime` type,
 *     `openclaw/plugin-sdk/runtime-store` for the factory.
 *   - docs/plugins/sdk-runtime.md §"Runtime store pattern".
 */
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setEclawRuntime, getRuntime: getEclawRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "E-Claw runtime not initialized - plugin not registered",
  );

export { getEclawRuntime, setEclawRuntime };
