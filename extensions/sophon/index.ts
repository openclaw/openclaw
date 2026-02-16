import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import registerSophonPlugin from "./src/index.js";

export default function register(api: OpenClawPluginApi): void {
  registerSophonPlugin(api);
}
