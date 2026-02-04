/**
 * Agent Status API functions.
 *
 * Provides typed interfaces for querying live agent status, sessions,
 * and resource usage from the gateway. Includes mock data fallback
 * for development.
 */

import { getGatewayClient } from "./gateway-client";
import { listSessions, type GatewaySessionRow } from "./sessions";

// ── Types ──────────────────────────────────────────────────────────

export type AgentHealthStatus = "active" | "stalled" | "idle" | "errored";

export interface AgentResourceUsage {
  /** Total tokens consumed in the current/last session */
  tokensUsed: number;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Session duration in ms */
  durationMs: number;
}

export interface AgentStatusEntry {
  id: string;
  name: string;
  label?: string;
  health: AgentHealthStatus;
  currentTask?: string;
  sessionKey?: string;
  sessionCount: number;
  resources: AgentResourceUsage;
  lastActivityAt: number;
  tags?: string[];
  model?: string;
  pendingApprovals?: number;
}

export interface AgentStatusSnapshot {
  agents: AgentStatusEntry[];
  timestamp: number;
}

// ── Gateway event types (streamed via WebSocket) ───────────────────

export interface AgentStatusEvent {
  agentId: string;
  health: AgentHealthStatus;
  currentTask?: string;
  sessionKey?: string;
  tokensUsed?: number;
  estimatedCost?: number;
  lastActivityAt?: number;
}

// ── Mock data for development ──────────────────────────────────────

const MOCK_AGENTS: AgentStatusEntry[] = [
  {
    id: "main",
    name: "Main Agent",
    label: "Primary",
    health: "active",
    currentTask: "Processing user request via Slack",
    sessionKey: "agent:main:slack:channel:general",
    sessionCount: 3,
    resources: { tokensUsed: 45_230, estimatedCost: 0.68, durationMs: 182_000 },
    lastActivityAt: Date.now() - 5_000,
    tags: ["slack", "primary"],
    model: "claude-sonnet-4-20250514",
  },
  {
    id: "research",
    name: "Research Agent",
    label: "Subagent",
    health: "active",
    currentTask: "Analyzing market data for Q1 report",
    sessionKey: "agent:main:subagent:research-01",
    sessionCount: 1,
    resources: { tokensUsed: 28_100, estimatedCost: 0.42, durationMs: 95_000 },
    lastActivityAt: Date.now() - 12_000,
    tags: ["research", "subagent"],
    model: "claude-sonnet-4-20250514",
  },
  {
    id: "code-helper",
    name: "Code Helper",
    health: "idle",
    sessionKey: "agent:code-helper:main",
    sessionCount: 5,
    resources: { tokensUsed: 112_400, estimatedCost: 1.69, durationMs: 480_000 },
    lastActivityAt: Date.now() - 300_000,
    tags: ["code", "development"],
    model: "claude-sonnet-4-20250514",
  },
  {
    id: "writer",
    name: "Writing Coach",
    health: "stalled",
    currentTask: "Waiting for user feedback on draft",
    sessionKey: "agent:writer:main",
    sessionCount: 2,
    resources: { tokensUsed: 8_750, estimatedCost: 0.13, durationMs: 42_000 },
    lastActivityAt: Date.now() - 600_000,
    tags: ["writing", "editing"],
    model: "claude-haiku-3-5-20241022",
    pendingApprovals: 1,
  },
  {
    id: "autodev",
    name: "Autodev Worker",
    label: "Autonomous",
    health: "active",
    currentTask: "Building agent status dashboard",
    sessionKey: "agent:main:subagent:autodev-01",
    sessionCount: 1,
    resources: { tokensUsed: 67_800, estimatedCost: 1.02, durationMs: 320_000 },
    lastActivityAt: Date.now() - 2_000,
    tags: ["autodev", "subagent"],
    model: "claude-sonnet-4-20250514",
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    health: "errored",
    currentTask: "Failed: API rate limit exceeded",
    sessionKey: "agent:data-analyst:main",
    sessionCount: 1,
    resources: { tokensUsed: 3_200, estimatedCost: 0.05, durationMs: 15_000 },
    lastActivityAt: Date.now() - 120_000,
    tags: ["data", "analytics"],
    model: "claude-haiku-3-5-20241022",
  },
];

// ── API functions ──────────────────────────────────────────────────

/**
 * Fetch agent status snapshot. Uses gateway `agents.status` RPC when available,
 * falls back to constructing status from sessions + config.
 */
export async function getAgentStatus(liveMode: boolean): Promise<AgentStatusSnapshot> {
  if (!liveMode) {
    // Simulate latency
    await new Promise((r) => setTimeout(r, 400));
    return { agents: MOCK_AGENTS, timestamp: Date.now() };
  }

  try {
    const client = getGatewayClient();

    // Try the dedicated agents.status endpoint first
    try {
      const result = await client.request<AgentStatusSnapshot>("agents.status", {});
      return result;
    } catch {
      // Endpoint may not exist yet — construct from sessions
    }

    // Fallback: build from session list
    const sessionsResult = await listSessions({
      includeGlobal: false,
      includeLastMessage: true,
      includeDerivedTitles: true,
      activeMinutes: 60,
    });

    const agentMap = new Map<string, AgentStatusEntry>();

    for (const session of sessionsResult.sessions) {
      const agentId = extractAgentId(session.key);
      if (!agentId) continue;

      const existing = agentMap.get(agentId);
      if (existing) {
        existing.sessionCount++;
        if (session.lastMessageAt && session.lastMessageAt > existing.lastActivityAt) {
          existing.lastActivityAt = session.lastMessageAt;
        }
      } else {
        agentMap.set(agentId, {
          id: agentId,
          name: agentId,
          health: inferHealth(session),
          currentTask: session.lastMessage ?? undefined,
          sessionKey: session.key,
          sessionCount: 1,
          resources: { tokensUsed: 0, estimatedCost: 0, durationMs: 0 },
          lastActivityAt: session.lastMessageAt ?? 0,
          tags: session.tags ?? [],
        });
      }
    }

    return {
      agents: Array.from(agentMap.values()),
      timestamp: Date.now(),
    };
  } catch {
    // Fallback to mock on error
    return { agents: MOCK_AGENTS, timestamp: Date.now() };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function extractAgentId(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:([^:]+)/);
  return match?.[1] ?? null;
}

function inferHealth(session: GatewaySessionRow): AgentHealthStatus {
  if (!session.lastMessageAt) return "idle";
  const age = Date.now() - session.lastMessageAt;
  if (age < 30_000) return "active";
  if (age < 300_000) return "stalled";
  return "idle";
}
