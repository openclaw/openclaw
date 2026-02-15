import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createCalendarTools } from "./src/calendar-tools.js";

export default function register(api: OpenClawPluginApi) {
  const tools = createCalendarTools(api);
  for (const tool of tools) {
    api.registerTool(tool as unknown as AnyAgentTool, { optional: true });
  }
}
