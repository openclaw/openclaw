/**
 * Meta-reasoning tools aggregator.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createMetaReasoningTool } from "./meta-reasoning.js";

export function createMetaReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [createMetaReasoningTool(api)];
}
