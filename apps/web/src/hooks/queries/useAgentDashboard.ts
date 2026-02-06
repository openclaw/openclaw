/**
 * Aggregated data hook for the Agents dashboard.
 *
 * Combines agent status, session list, and cron jobs into a single
 * dashboard-friendly dataset.
 */

import * as React from "react";
import { useAgentStatusDashboard, type AgentHealthStatus } from "@/hooks/queries/useAgentStatus";
import { useAgents } from "@/hooks/queries/useAgents";
import { useSessions } from "@/hooks/queries/useSessions";
import { useCronJobs } from "@/hooks/queries/useCron";
import type { Agent } from "@/stores/useAgentStore";
import type { GatewaySessionRow } from "@/lib/api/sessions";
import type { CronJob } from "@/lib/api/cron";

export interface AgentDashboardEntry {
  id: string;
  name: string;
  label?: string;
  health: AgentHealthStatus;
  currentTask?: string;
  sessions: GatewaySessionRow[];
  activeSessions: number;
  sessionCount: number;
  tokensUsed: number;
  estimatedCost: number;
  lastActivityAt: number | null;
  cronJobs: CronJob[];
}

export interface AgentDashboardSummary {
  total: number;
  active: number;
  idle: number;
  stalled: number;
  errored: number;
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  totalCronJobs: number;
}

export interface AgentDashboardData {
  entries: AgentDashboardEntry[];
  summary: AgentDashboardSummary;
  lastUpdated?: number;
}

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const STALE_THRESHOLD_MS = 30 * 60 * 1000;

function extractAgentId(sessionKey: string): string | null {
  const match = sessionKey.match(/^agent:([^:]+)/);
  return match?.[1] ?? null;
}

function mapAgentStatusToHealth(status?: Agent["status"]): AgentHealthStatus | null {
  if (!status) return null;
  switch (status) {
    case "online":
      return "active";
    case "busy":
      return "stalled";
    case "paused":
      return "idle";
    case "offline":
      return "errored";
    default:
      return null;
  }
}

function deriveHealthFromSessions(sessions: GatewaySessionRow[], now: number): AgentHealthStatus {
  if (sessions.length === 0) return "idle";
  const lastActivity = sessions.reduce((latest, session) => {
    if (!session.lastMessageAt) return latest;
    return Math.max(latest, session.lastMessageAt);
  }, 0);
  const age = now - lastActivity;
  if (age < ACTIVE_THRESHOLD_MS) return "active";
  if (age < STALE_THRESHOLD_MS) return "stalled";
  return "idle";
}

function computeLastActivity(sessions: GatewaySessionRow[]): number | null {
  const last = sessions.reduce<number | null>((latest, session) => {
    if (!session.lastMessageAt) return latest;
    if (latest === null) return session.lastMessageAt;
    return Math.max(latest, session.lastMessageAt);
  }, null);
  return last;
}

export function useAgentDashboardData() {
  const agentStatusQuery = useAgentStatusDashboard({ pollInterval: 10_000 });
  const agentsQuery = useAgents();
  const sessionsQuery = useSessions();
  const cronQuery = useCronJobs();

  const data = React.useMemo<AgentDashboardData>(() => {
    const now = Date.now();
    const agents = agentsQuery.data ?? [];
    const statusAgents = agentStatusQuery.data?.agents ?? [];
    const sessions = sessionsQuery.data?.sessions ?? [];
    const cronJobs = cronQuery.data?.jobs ?? [];

    const statusById = new Map(statusAgents.map((agent) => [agent.id, agent]));
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

    const sessionsByAgent = new Map<string, GatewaySessionRow[]>();
    sessions.forEach((session) => {
      const agentId = extractAgentId(session.key);
      if (!agentId) return;
      const existing = sessionsByAgent.get(agentId) ?? [];
      existing.push(session);
      sessionsByAgent.set(agentId, existing);
    });

    const cronByAgent = new Map<string, CronJob[]>();
    cronJobs.forEach((job) => {
      const existing = cronByAgent.get(job.agentId) ?? [];
      existing.push(job);
      cronByAgent.set(job.agentId, existing);
    });

    const agentIds = new Set<string>();
    agents.forEach((agent) => agentIds.add(agent.id));
    statusAgents.forEach((agent) => agentIds.add(agent.id));
    sessionsByAgent.forEach((_sessions, agentId) => agentIds.add(agentId));
    cronByAgent.forEach((_jobs, agentId) => agentIds.add(agentId));

    const entries = Array.from(agentIds).map((agentId) => {
      const agent = agentsById.get(agentId);
      const status = statusById.get(agentId);
      const agentSessions = sessionsByAgent.get(agentId) ?? [];
      const agentCron = cronByAgent.get(agentId) ?? [];

      const lastActivityFromSessions = computeLastActivity(agentSessions);
      const lastActivityAt = status?.lastActivityAt
        ? status.lastActivityAt
        : lastActivityFromSessions;

      const health = status?.health
        ?? mapAgentStatusToHealth(agent?.status)
        ?? deriveHealthFromSessions(agentSessions, now);

      const sessionCount = status?.sessionCount ?? agentSessions.length;
      const activeSessions = agentSessions.filter(
        (session) => session.lastMessageAt && now - session.lastMessageAt < ACTIVE_THRESHOLD_MS
      ).length;

      return {
        id: agentId,
        name: agent?.name ?? status?.name ?? agentId,
        label: status?.label,
        health,
        currentTask: status?.currentTask ?? agent?.currentTask,
        sessions: agentSessions,
        activeSessions,
        sessionCount,
        tokensUsed: status?.resources.tokensUsed ?? 0,
        estimatedCost: status?.resources.estimatedCost ?? 0,
        lastActivityAt,
        cronJobs: agentCron,
      } satisfies AgentDashboardEntry;
    });

    const summary: AgentDashboardSummary = {
      total: entries.length,
      active: entries.filter((entry) => entry.health === "active").length,
      idle: entries.filter((entry) => entry.health === "idle").length,
      stalled: entries.filter((entry) => entry.health === "stalled").length,
      errored: entries.filter((entry) => entry.health === "errored").length,
      totalSessions: entries.reduce((sum, entry) => sum + entry.sessionCount, 0),
      totalTokens: entries.reduce((sum, entry) => sum + entry.tokensUsed, 0),
      totalCost: entries.reduce((sum, entry) => sum + entry.estimatedCost, 0),
      totalCronJobs: entries.reduce((sum, entry) => sum + entry.cronJobs.length, 0),
    };

    const lastUpdated = agentStatusQuery.data?.timestamp ?? sessionsQuery.data?.ts;

    return { entries, summary, lastUpdated };
  }, [agentStatusQuery.data, agentsQuery.data, sessionsQuery.data, cronQuery.data]);

  const isLoading =
    agentStatusQuery.isLoading
    || agentsQuery.isLoading
    || sessionsQuery.isLoading
    || cronQuery.isLoading;

  const isFetching =
    agentStatusQuery.isFetching
    || agentsQuery.isFetching
    || sessionsQuery.isFetching
    || cronQuery.isFetching;

  const error =
    agentStatusQuery.error
    ?? agentsQuery.error
    ?? sessionsQuery.error
    ?? cronQuery.error;

  const refetch = async () => {
    await Promise.all([
      agentStatusQuery.refetch(),
      agentsQuery.refetch(),
      sessionsQuery.refetch(),
      cronQuery.refetch(),
    ]);
  };

  return {
    ...data,
    isLoading,
    isFetching,
    error,
    refetch,
  };
}
