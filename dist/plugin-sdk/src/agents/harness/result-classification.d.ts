import type { AgentHarness, AgentHarnessAttemptParams, AgentHarnessAttemptResult } from "./types.js";
export declare function applyAgentHarnessResultClassification(harness: Pick<AgentHarness, "id" | "classify">, result: AgentHarnessAttemptResult, params: AgentHarnessAttemptParams): AgentHarnessAttemptResult;
