/**
 * Decision API client.
 *
 * Fetches decision records via the gateway RPC `decision.list` / `decision.get`.
 */

import { getGatewayClient } from "./gateway-client";

export type DecisionStatus = "pending" | "responded" | "expired";

export interface DecisionRecord {
  decisionId: string;
  type: "binary" | "choice" | "text" | "confirmation";
  status: DecisionStatus;
  title: string;
  question: string;
  options?: Array<{
    id: string;
    label: string;
    value: string;
    style?: string;
  }>;
  context: {
    sessionKey?: string;
    agentId?: string;
    goalId?: string;
    assignmentId?: string;
  };
  slackChannel?: string;
  slackMessageTs?: string;
  respondedBy?: {
    userId: string;
    userName?: string;
  };
  respondedAt?: number;
  response?: {
    optionId?: string;
    optionValue?: string;
    textValue?: string;
  };
  createdAt: number;
  expiresAt?: number;
}

export interface DecisionListParams {
  status?: DecisionStatus;
  agentId?: string;
  sessionKey?: string;
}

/**
 * List decisions from the gateway.
 */
export async function listDecisions(
  params: DecisionListParams = {}
): Promise<DecisionRecord[]> {
  const client = getGatewayClient();
  const result = await client.request<{ decisions: DecisionRecord[] }>(
    "decision.list",
    params
  );
  return result.decisions;
}

/**
 * Get a single decision by ID.
 */
export async function getDecision(
  decisionId: string
): Promise<DecisionRecord | null> {
  const client = getGatewayClient();
  const result = await client.request<{ decision: DecisionRecord }>(
    "decision.get",
    { decisionId }
  );
  return result.decision;
}
