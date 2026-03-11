import type { OpenClawPluginApi } from "openclaw/plugin-sdk/pilot";
import { registerPilotDiscoverTool } from "./pilot-discover.js";
import { registerPilotEventTools } from "./pilot-events.js";
import { registerPilotSendTool } from "./pilot-send.js";
import { registerPilotTaskTool } from "./pilot-task.js";
import { registerPilotTrustTool } from "./pilot-trust.js";

export function registerPilotTools(api: OpenClawPluginApi) {
  registerPilotSendTool(api);
  registerPilotTrustTool(api);
  registerPilotDiscoverTool(api);
  registerPilotTaskTool(api);
  registerPilotEventTools(api);
}
