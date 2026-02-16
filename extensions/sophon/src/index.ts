import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerDashboardTools } from "./tools/dashboard.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";

export default function registerSophonPlugin(api: OpenClawPluginApi): void {
  registerTaskTools(api);
  registerProjectTools(api);
  registerNoteTools(api);
  registerDashboardTools(api);
}
