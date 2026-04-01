/**
 * Type declarations for the BDI runtime module that is dynamically imported
 * at runtime from the workspace directory.
 */

import type { CognitiveRouterConfig } from "../tools/cognitive-router-types.js";

export interface AgentBdiConfig {
  commitmentStrategy?: "single-minded" | "open-minded" | "cautious";
  cycleFrequency?: {
    fullCycleMinutes?: number;
    quickCheckMinutes?: number;
  };
  reasoningMethods?: string[];
  cognitiveRouter?: CognitiveRouterConfig;
}

export interface AgentCognitiveState {
  agentId: string;
  agentDir: string;
  beliefs: unknown[];
  goals: unknown[];
  intentions: unknown[];
  desires: unknown[];
}

export interface AgentSummaryItem {
  agentId: string;
  beliefCount: number;
  goalCount: number;
  intentionCount: number;
  desireCount: number;
}

export interface BdiRuntime {
  discoverAgents(workspaceDir: string): Promise<string[]>;
  readAgentCognitiveState(agentDir: string, agentId: string): Promise<AgentCognitiveState>;
  runMaintenanceCycle(state: AgentCognitiveState): Promise<void>;
  getAgentsSummary(workspaceDir: string): Promise<AgentSummaryItem[]>;
}
