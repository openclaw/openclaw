/**
 * Causal reasoning tools aggregator.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createCausalTool } from "./causal.js";
import { createCounterfactualTool } from "./counterfactual.js";
import { createScenarioTool } from "./scenario.js";
import { createTemporalTool } from "./temporal.js";

export function createCausalReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    createCausalTool(api),
    createCounterfactualTool(api),
    createTemporalTool(api),
    createScenarioTool(api),
  ];
}
