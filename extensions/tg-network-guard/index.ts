import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import registerRuntime from "./src/runtime.js";

export default function register(api: OpenClawPluginApi) {
  registerRuntime(api);
}
