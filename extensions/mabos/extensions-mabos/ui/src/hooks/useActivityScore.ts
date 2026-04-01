import { useMemo } from "react";
import type { AgentPulse } from "@/components/dashboard/HeartbeatMonitor";
import type { SystemStatus, AgentListItem, CronJob } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  active: "var(--accent-green)",
  idle: "var(--accent-orange)",
  error: "var(--accent-red)",
  paused: "var(--text-muted)",
};

const COGNITIVE_THRESHOLD = 50; // normalize cognitive load against this total

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function useActivityScore(
  status: SystemStatus | undefined,
  agents: AgentListItem[] | undefined,
  cronJobs: CronJob[] | undefined,
) {
  return useMemo(() => {
    // --- Agent score ---
    const totalAgents = agents?.length ?? 0;
    const activeAgents = agents?.filter((a) => a.status === "active").length ?? 0;
    const agentScore = totalAgents > 0 ? activeAgents / totalAgents : 0;

    // --- Cron score ---
    const enabledJobs = cronJobs?.filter((j) => j.enabled) ?? [];
    const totalEnabled = enabledJobs.length;
    const now = Date.now();
    const RECENT_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    const recentlyRan = enabledJobs.filter((j) => {
      if (!j.lastRun) return false;
      return now - new Date(j.lastRun).getTime() < RECENT_THRESHOLD;
    }).length;
    const cronScore = totalEnabled > 0 ? recentlyRan / totalEnabled : 0;

    // --- Cognitive load ---
    const bdiAgents = status?.agents ?? [];
    let totalCognitive = 0;
    for (const a of bdiAgents) {
      totalCognitive += (a.beliefCount ?? 0) + (a.goalCount ?? 0) + (a.intentionCount ?? 0);
    }
    const cognitiveLoad = clamp(totalCognitive / COGNITIVE_THRESHOLD);

    // --- Composite ---
    const activityLevel = clamp(0.4 * agentScore + 0.3 * cronScore + 0.3 * cognitiveLoad);

    // --- Per-agent pulses ---
    const agentPulses: AgentPulse[] = (agents ?? []).map((agent) => {
      const bdi = bdiAgents.find((b) => b.agentId === agent.id);
      const cognitive = bdi
        ? clamp(
            ((bdi.beliefCount ?? 0) + (bdi.goalCount ?? 0) + (bdi.intentionCount ?? 0)) /
              (COGNITIVE_THRESHOLD / Math.max(bdiAgents.length, 1)),
          )
        : 0;
      const statusWeight = agent.status === "active" ? 1 : agent.status === "idle" ? 0.4 : 0.1;
      return {
        id: agent.id,
        name: agent.name,
        color: STATUS_COLORS[agent.status] ?? STATUS_COLORS.paused,
        intensity: clamp(statusWeight * 0.6 + cognitive * 0.4),
      };
    });

    return { activityLevel, agentPulses };
  }, [status, agents, cronJobs]);
}
