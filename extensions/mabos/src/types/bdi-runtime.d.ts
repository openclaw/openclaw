/**
 * Type declarations for the BDI runtime module that is dynamically imported
 * at runtime from the workspace directory.
 */

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
