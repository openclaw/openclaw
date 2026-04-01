/**
 * Social reasoning tools aggregator.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { createDialecticalTool } from "./dialectical.js";
import { createEthicalTool } from "./ethical.js";
import { createGameTheoreticTool } from "./game-theory.js";
import { createTrustTool } from "./trust.js";

export function createSocialReasoningTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    createDialecticalTool(api),
    createTrustTool(api),
    createGameTheoreticTool(api),
    createEthicalTool(api),
  ];
}
