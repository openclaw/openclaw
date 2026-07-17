import type { ToolResultMessage } from "../../llm-core/src/index.js";
import type { AgentTool } from "./types.js";

export type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  terminate: boolean;
};

export type ResolvedToolCallOutcome =
  | { kind: "resolved"; tool?: AgentTool }
  | { kind: "error"; error: unknown };
