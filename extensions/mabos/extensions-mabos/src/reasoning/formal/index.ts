/**
 * Formal reasoning tools aggregator.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createAbductiveTool } from "./abductive.js";
import { createConstraintTool } from "./constraint.js";
import { createDeductiveTool } from "./deductive.js";
import { createDeonticTool } from "./deontic.js";
import { createInductiveTool } from "./inductive.js";
import { createModalTool } from "./modal.js";

export function createFormalReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    createDeductiveTool(api),
    createInductiveTool(api),
    createAbductiveTool(api),
    createModalTool(api),
    createDeonticTool(api),
    createConstraintTool(api),
  ];
}
