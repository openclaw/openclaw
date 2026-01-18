import type { ClawdbotPluginApi } from "../../src/plugins/types.js";

import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: ClawdbotPluginApi) {
  api.registerTool(createLobsterTool(api), { optional: true });
}
