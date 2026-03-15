import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/discord";

// Avoid destructured rename so jiti transpilation cannot mangle the bindings.
const _runtimeStore = createPluginRuntimeStore<PluginRuntime>("Discord runtime not initialized");
const setDiscordRuntime = _runtimeStore.setRuntime;
const getDiscordRuntime = _runtimeStore.getRuntime;
export { getDiscordRuntime, setDiscordRuntime };
