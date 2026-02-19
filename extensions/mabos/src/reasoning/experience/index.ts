/**
 * Experience-based reasoning tools aggregator.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createAnalogicalTool } from "./analogical.js";

export function createExperienceReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [createAnalogicalTool(api)];
}
