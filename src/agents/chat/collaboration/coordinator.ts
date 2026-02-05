/**
 * Coordinator pattern implementation for multi-agent collaboration.
 * A coordinator agent routes messages to appropriate specialists.
 */

import type {
  CollaborationSession,
  ExpertPanelConfig,
  ChainConfig,
  CoordinatorConfig,
  AgentResponse,
  HandoffRequest,
} from "./types.js";
import {
  getActiveSession,
  emitExpertActivated,
  emitHandoffRequested,
  emitHandoffAccepted,
  recordContribution,
} from "./session-manager.js";

export type CoordinatorDecision = {
  targetAgents: string[];
  reason: string;
  shouldRespond: boolean;
  handoffContext?: string;
};

/**
 * Make a coordination decision for a message.
 */
export async function coordinateMessage(
  session: CollaborationSession,
  message: string,
  authorId: string,
): Promise<CoordinatorDecision> {
  switch (session.mode) {
    case "war-room":
      return coordinateWarRoom(session, message, authorId);

    case "expert-panel":
      return coordinateExpertPanel(session, message, authorId);

    case "chain-of-thought":
      return coordinateChain(session, message, authorId);

    case "coordinator":
      return coordinateWithRules(session, message, authorId);

    case "consensus":
      return coordinateConsensus(session, message, authorId);

    default:
      return {
        targetAgents: [],
        reason: "unknown_mode",
        shouldRespond: false,
      };
  }
}

/**
 * War room: All agents respond simultaneously.
 */
function coordinateWarRoom(
  session: CollaborationSession,
  message: string,
  authorId: string,
): CoordinatorDecision {
  const activeParticipants = session.participants
    .filter((p) => !p.leftAt && p.agentId !== authorId)
    .map((p) => p.agentId);

  return {
    targetAgents: activeParticipants,
    reason: "war_room_broadcast",
    shouldRespond: true,
  };
}

/**
 * Expert panel: Activate experts based on topic detection.
 */
function coordinateExpertPanel(
  session: CollaborationSession,
  message: string,
  authorId: string,
): CoordinatorDecision {
  const config = session.config as ExpertPanelConfig;
  const expertiseMapping = config.expertiseMapping ?? new Map();
  const activationThreshold = config.activationThreshold ?? 0.5;

  // Analyze message for topics
  const detectedTopics = detectTopics(message, expertiseMapping);

  if (detectedTopics.length === 0) {
    // No topic detected, use fallback or coordinator
    if (config.allowFallback) {
      return {
        targetAgents: session.coordinator ? [session.coordinator] : [],
        reason: "no_expert_match_fallback",
        shouldRespond: true,
      };
    }
    return {
      targetAgents: [],
      reason: "no_expert_match",
      shouldRespond: false,
    };
  }

  // Activate experts for detected topics
  const experts = new Set<string>();
  for (const { topic, agentIds, confidence } of detectedTopics) {
    if (confidence >= activationThreshold) {
      for (const agentId of agentIds) {
        if (agentId !== authorId) {
          experts.add(agentId);
          emitExpertActivated(session.sessionId, agentId, topic);
        }
      }
    }
  }

  return {
    targetAgents: [...experts],
    reason: `expert_activation:${detectedTopics.map((t) => t.topic).join(",")}`,
    shouldRespond: true,
  };
}

/**
 * Chain of thought: Sequential processing through agents.
 */
function coordinateChain(
  session: CollaborationSession,
  message: string,
  authorId: string,
): CoordinatorDecision {
  const config = session.config as ChainConfig;
  const chainOrder = config.chainOrder ?? [];

  if (chainOrder.length === 0) {
    return {
      targetAgents: [],
      reason: "empty_chain",
      shouldRespond: false,
    };
  }

  // Find current position in chain
  const currentIndex = chainOrder.indexOf(authorId);

  let nextIndex: number;
  if (currentIndex === -1) {
    // Not in chain, start from beginning
    nextIndex = 0;
  } else if (currentIndex === chainOrder.length - 1) {
    // End of chain
    if (config.isLoop) {
      nextIndex = 0;
    } else {
      return {
        targetAgents: [],
        reason: "chain_complete",
        shouldRespond: false,
      };
    }
  } else {
    nextIndex = currentIndex + 1;
  }

  const nextAgent = chainOrder[nextIndex];

  return {
    targetAgents: [nextAgent],
    reason: `chain_step:${nextIndex + 1}/${chainOrder.length}`,
    shouldRespond: true,
    handoffContext: `Chain step ${nextIndex + 1} of ${chainOrder.length}`,
  };
}

/**
 * Coordinator mode: Use routing rules.
 */
function coordinateWithRules(
  session: CollaborationSession,
  message: string,
  authorId: string,
): CoordinatorDecision {
  const config = session.config as CoordinatorConfig;
  const rules = config.routingRules ?? [];

  // Sort rules by priority
  const sortedRules = [...rules].toSorted((a, b) => b.priority - a.priority);

  // Find matching rule
  for (const rule of sortedRules) {
    if (rule.pattern.test(message)) {
      const targets = rule.targetAgents.filter((id) => id !== authorId);
      return {
        targetAgents: targets,
        reason: `rule_match:${rule.pattern.source}`,
        shouldRespond: true,
      };
    }
  }

  // No rule matched, coordinator decides
  if (config.coordinatorCanRespond && session.coordinator) {
    return {
      targetAgents: [session.coordinator],
      reason: "coordinator_fallback",
      shouldRespond: true,
    };
  }

  return {
    targetAgents: [],
    reason: "no_rule_match",
    shouldRespond: false,
  };
}

/**
 * Consensus mode: All agents vote.
 */
function coordinateConsensus(
  session: CollaborationSession,
  message: string,
  authorId: string,
): CoordinatorDecision {
  const activeParticipants = session.participants
    .filter((p) => !p.leftAt && p.agentId !== authorId && p.role !== "observer")
    .map((p) => p.agentId);

  return {
    targetAgents: activeParticipants,
    reason: "consensus_vote_request",
    shouldRespond: true,
  };
}

/**
 * Detect topics in a message based on expertise mapping.
 */
function detectTopics(
  message: string,
  expertiseMapping: Map<string, string[]>,
): { topic: string; agentIds: string[]; confidence: number }[] {
  const results: { topic: string; agentIds: string[]; confidence: number }[] = [];
  const lowerMessage = message.toLowerCase();

  for (const [topic, agentIds] of expertiseMapping) {
    // Simple keyword matching
    const keywords = topic.toLowerCase().split(/\s+/);
    let matchCount = 0;

    for (const keyword of keywords) {
      if (lowerMessage.includes(keyword)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      const confidence = matchCount / keywords.length;
      results.push({ topic, agentIds, confidence });
    }
  }

  // Sort by confidence
  return results.toSorted((a, b) => b.confidence - a.confidence);
}

/**
 * Request handoff from one agent to another.
 */
export async function requestHandoff(
  channelId: string,
  fromAgent: string,
  toAgent: string,
  context: string,
): Promise<HandoffRequest> {
  const session = await getActiveSession(channelId);
  if (!session) {
    throw new Error("No active collaboration session");
  }

  const request: HandoffRequest = {
    fromAgent,
    toAgent,
    context,
    timestamp: Date.now(),
  };

  emitHandoffRequested(session.sessionId, fromAgent, toAgent, context);

  return request;
}

/**
 * Accept a handoff request.
 */
export async function acceptHandoff(channelId: string, agentId: string): Promise<void> {
  const session = await getActiveSession(channelId);
  if (!session) {
    throw new Error("No active collaboration session");
  }

  emitHandoffAccepted(session.sessionId, agentId);
  await recordContribution(session.sessionId, agentId);
}

/**
 * Get the next agent in a chain.
 */
export function getNextInChain(session: CollaborationSession, currentAgent: string): string | null {
  if (session.mode !== "chain-of-thought") {
    return null;
  }

  const config = session.config as ChainConfig;
  const chainOrder = config.chainOrder ?? [];

  const currentIndex = chainOrder.indexOf(currentAgent);
  if (currentIndex === -1) {
    return chainOrder[0] ?? null;
  }

  if (currentIndex === chainOrder.length - 1) {
    return config.isLoop ? chainOrder[0] : null;
  }

  return chainOrder[currentIndex + 1];
}

/**
 * Check if consensus has been reached.
 */
export function checkConsensus(
  votes: Map<string, string>,
  threshold: number,
  requireUnanimous: boolean,
): { reached: boolean; result?: string } {
  if (votes.size === 0) {
    return { reached: false };
  }

  // Count votes
  const voteCounts = new Map<string, number>();
  for (const vote of votes.values()) {
    voteCounts.set(vote, (voteCounts.get(vote) ?? 0) + 1);
  }

  // Check for unanimous
  if (requireUnanimous) {
    const uniqueVotes = new Set(votes.values());
    if (uniqueVotes.size === 1) {
      return { reached: true, result: [...uniqueVotes][0] };
    }
    return { reached: false };
  }

  // Check threshold
  for (const [vote, count] of voteCounts) {
    const ratio = count / votes.size;
    if (ratio >= threshold) {
      return { reached: true, result: vote };
    }
  }

  return { reached: false };
}

/**
 * Aggregate responses from multiple agents.
 */
export function aggregateResponses(
  responses: AgentResponse[],
  mode: "concat" | "summarize" | "vote",
): string {
  if (responses.length === 0) {
    return "";
  }

  switch (mode) {
    case "concat":
      return responses.map((r) => `**${r.agentId}:** ${r.content}`).join("\n\n");

    case "vote": {
      // Find most common response
      const counts = new Map<string, number>();
      for (const r of responses) {
        counts.set(r.content, (counts.get(r.content) ?? 0) + 1);
      }
      let maxCount = 0;
      let winner = "";
      for (const [content, count] of counts) {
        if (count > maxCount) {
          maxCount = count;
          winner = content;
        }
      }
      return winner;
    }

    case "summarize":
      // Simple concatenation with deduplication of key points
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const r of responses) {
        const normalized = r.content.toLowerCase().trim();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          unique.push(r.content);
        }
      }
      return unique.join("\n\n");

    default:
      return responses[0]?.content ?? "";
  }
}
