/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "../../runtime/index.js";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.js";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool } from "./types.js";

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(
  registeredTools: RegisteredTool[],
  runner: ExtensionRunner,
): AgentTool[] {
  return registeredTools.map((tool) =>
    wrapToolDefinition(tool.definition, () => runner.createContext()),
  );
}
