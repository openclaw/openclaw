import { NextResponse } from "next/server";
import { getAgentTaskMonitor } from "@/lib/agent-task-monitor";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";

/**
 * GET /api/tasks/check-completion
 *
 * Triggers recovery of orphaned in_progress tasks that lost their monitor
 * (e.g., after server restart). The AgentTaskMonitor handles all completion
 * detection — this endpoint just ensures orphans get re-monitored.
 *
 * The actual completion detection is unified in AgentTaskMonitor to prevent
 * duplicate comments and status transitions.
 */
export const GET = withApiGuard(async () => {
  try {
    const monitor = getAgentTaskMonitor();

    // Get current state before recovery
    const activeMonitors = monitor.getActiveMonitors();

    // Recover any orphaned tasks (in_progress but not monitored)
    const { recovered, taskIds } = await monitor.recoverOrphanedTasks();

    return NextResponse.json({
      activeMonitors: activeMonitors.length,
      recoveredTasks: recovered,
      recoveredTaskIds: taskIds,
      message:
        recovered > 0
          ? `Recovered ${recovered} orphaned task(s) — now being monitored`
          : "All in_progress tasks are being monitored",
    });
  } catch (error) {
    return handleApiError(error, "Failed to check task completion monitors");
  }
}, ApiGuardPresets.read);
