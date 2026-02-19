import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { registerExecPassthrough } from "./src/passthrough.js";

export default function register(api: OpenClawPluginApi) {
  registerExecPassthrough(api);
}
