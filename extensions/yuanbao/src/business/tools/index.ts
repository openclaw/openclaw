/**
 * Tools registration factory.
 *
 * Centralized tool registration logic, grouped by category.
 * Plugin entry only needs to call registerTools(api) to register all tools.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerGroupTools } from "./group.js";
import { registerMemberTools } from "./member.js";

export function registerTools(api: OpenClawPluginApi): void {
  registerMemberTools(api);
  registerGroupTools(api);
}
