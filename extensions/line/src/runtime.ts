import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "../api.js";

const {
	setRuntime: setLineRuntime,
	clearRuntime: clearLineRuntime,
	getRuntime: getLineRuntime,
} = createPluginRuntimeStore<PluginRuntime>(
	"LINE runtime not initialized - plugin not registered",
);
export { clearLineRuntime, getLineRuntime, setLineRuntime };
