/**
 * Probabilistic reasoning tools aggregator.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createBayesianTool } from "./bayesian.js";
import { createFuzzyTool } from "./fuzzy.js";
import { createStatisticalTool } from "./statistical.js";

export function createProbabilisticReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [createBayesianTool(api), createStatisticalTool(api), createFuzzyTool(api)];
}
