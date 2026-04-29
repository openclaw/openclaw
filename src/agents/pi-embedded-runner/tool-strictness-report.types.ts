import type {
  ToolStrictnessRepairEvent,
  ToolStrictnessMode,
  ToolStrictnessSummary,
} from "../tool-strictness.js";

export type ToolStrictnessReport = {
  compatibilityObservations: Array<{
    kind: "toolCallBlockTypeCompatibility";
    from: "tool_call" | "functionCall";
    to: "toolCall";
    phase: "replay-sanitize";
    mode: ToolStrictnessMode;
  }>;
  toolUseDiagnostics: Array<{
    kind: "toolUseReplayDiagnostic";
    reason: "pairingSensitiveReplay" | "providerOwnedThinkingReplay";
    provider: "anthropic" | "generic";
    hasEmbeddedToolResult: boolean;
    toolUseCount: number;
    phase: "replay-sanitize";
    mode: ToolStrictnessMode;
  }>;
  repairs: ToolStrictnessRepairEvent[];
  summary: ToolStrictnessSummary;
};
