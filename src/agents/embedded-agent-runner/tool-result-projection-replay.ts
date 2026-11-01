import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  createToolResultPromptProjectionState,
  type ToolResultPromptProjectionState,
} from "./session-prompt-state.js";
import { projectToolResultMessages } from "./tool-result-truncation.js";

/** Replay the parent's admitted bytes without advancing its pruning state. */
export function replayToolResultPromptProjections(
  messages: AgentMessage[],
  projectionState: ToolResultPromptProjectionState,
): AgentMessage[] {
  return projectToolResultMessages({
    messages,
    projectionState: createToolResultPromptProjectionState(projectionState),
  }).messages;
}
