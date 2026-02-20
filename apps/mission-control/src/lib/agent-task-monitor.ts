import { v4 as uuidv4 } from "uuid";
import { getOpenClawClient } from "./openclaw-client";
import { getTask, updateTask, addComment, logActivity, listTasks } from "./db";
import { getCurrentRiskConfig } from "./risk-level";

// --- Types ---

interface ActiveMonitor {
  taskId: string;
  sessionKey: string;
  agentId: string;
  startedAt: number;
  pollTimer: ReturnType<typeof setInterval>;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  lastMessageCount: number;
  checking: boolean;
}

// Track tasks currently being transitioned to prevent duplicates
const completingTasks = new Set<string>();

// --- Singleton ---

const globalForMonitor = globalThis as typeof globalThis & {
  __agentTaskMonitor?: AgentTaskMonitor;
};

class AgentTaskMonitor {
  private monitors: Map<string, ActiveMonitor> = new Map(); // sessionKey → monitor
  private readonly POLL_INTERVAL_MS = 10_000; // Check every 10 seconds

  /**
   * Start monitoring a dispatched task for agent completion.
   * Uses polling to check chat history for new assistant messages.
   */
  async startMonitoring(
    taskId: string,
    sessionKey: string,
    agentId: string
  ): Promise<void> {
    // Clean up any existing monitor for this session
    this.stopMonitoring(sessionKey);

    // Get initial message count so we can detect new messages
    let initialCount = 0;
    try {
      const client = getOpenClawClient();
      const history = await client.getChatHistory(sessionKey);
      initialCount = history.filter((m) => m.role === "assistant").length;
    } catch {
      // Start from 0 if we can't get history
    }

    // Set up polling interval
    const pollTimer = setInterval(async () => {
      await this.pollForCompletion(sessionKey);
    }, this.POLL_INTERVAL_MS);

    // Set up absolute timeout (from risk level config)
    const timeoutMs = getCurrentRiskConfig().agentTimeoutMs;
    const timeoutTimer = isFinite(timeoutMs)
      ? setTimeout(async () => {
        console.log(
          `[AgentTaskMonitor] Timeout for task ${taskId} (session: ${sessionKey}). Force-moving to review.`
        );
        await this.forceComplete(sessionKey, "timeout");
      }, timeoutMs)
      : null; // freedom mode: no timeout

    const monitor: ActiveMonitor = {
      taskId,
      sessionKey,
      agentId,
      startedAt: Date.now(),
      pollTimer,
      timeoutTimer,
      lastMessageCount: initialCount,
      checking: false,
    };

    this.monitors.set(sessionKey, monitor);
    console.log(
      `[AgentTaskMonitor] Monitoring started: task=${taskId}, session=${sessionKey}, agent=${agentId}, initialMsgs=${initialCount}`
    );
  }

  /**
   * Stop monitoring a specific session.
   */
  stopMonitoring(sessionKey: string): void {
    const monitor = this.monitors.get(sessionKey);
    if (monitor) {
      clearInterval(monitor.pollTimer);
      if (monitor.timeoutTimer) clearTimeout(monitor.timeoutTimer);
      this.monitors.delete(sessionKey);
      console.log(
        `[AgentTaskMonitor] Monitoring stopped: session=${sessionKey}`
      );
    }
  }

  /**
   * Get all currently active monitors.
   */
  getActiveMonitors(): {
    taskId: string;
    sessionKey: string;
    agentId: string;
    startedAt: number;
  }[] {
    return Array.from(this.monitors.values()).map(
      ({ taskId, sessionKey, agentId, startedAt }) => ({
        taskId,
        sessionKey,
        agentId,
        startedAt,
      })
    );
  }

  /**
   * Recover orphaned tasks — re-monitor in_progress tasks that have no active monitor.
   * Called on startup or when check-completion endpoint is hit.
   * Returns count of tasks recovered.
   */
  async recoverOrphanedTasks(): Promise<{ recovered: number; taskIds: string[] }> {
    const inProgressTasks = listTasks({ status: "in_progress" });
    const monitoredTaskIds = new Set(
      Array.from(this.monitors.values()).map((m) => m.taskId)
    );

    const orphaned = inProgressTasks.filter(
      (t) =>
        t.assigned_agent_id &&
        t.openclaw_session_key &&
        !monitoredTaskIds.has(t.id)
    );

    const recovered: string[] = [];

    for (const task of orphaned) {
      try {
        await this.startMonitoring(
          task.id,
          task.openclaw_session_key!,
          task.assigned_agent_id!
        );
        recovered.push(task.id);
        console.log(
          `[AgentTaskMonitor] Recovered orphaned task: ${task.id} (${task.title})`
        );
      } catch (err) {
        console.error(
          `[AgentTaskMonitor] Failed to recover task ${task.id}:`,
          String(err)
        );
      }
    }

    return { recovered: recovered.length, taskIds: recovered };
  }

  /**
   * Check if a task is currently being completed (guard against duplicates).
   */
  isTaskCompleting(taskId: string): boolean {
    return completingTasks.has(taskId);
  }

  // --- Private ---

  /**
   * Poll chat history to detect agent completion.
   * Checks if new assistant messages have appeared since we started monitoring.
   */
  private async pollForCompletion(sessionKey: string): Promise<void> {
    const monitor = this.monitors.get(sessionKey);
    if (!monitor) return;
    if (monitor.checking) return;
    monitor.checking = true;

    try {
      const task = getTask(monitor.taskId);
      if (!task || task.status !== "in_progress") {
        // Task was moved manually or doesn't exist anymore
        this.stopMonitoring(sessionKey);
        return;
      }

      const client = getOpenClawClient();

      // Skip polling when gateway is disconnected to avoid wasted retries
      if (!client.isConnected()) {
        return;
      }

      await client.connect();
      const history = await client.getChatHistory(sessionKey);
      const assistantMsgs = history.filter((m) => m.role === "assistant");

      // Check if new assistant messages have arrived
      if (assistantMsgs.length > monitor.lastMessageCount) {
        const previousCount = monitor.lastMessageCount;
        monitor.lastMessageCount = assistantMsgs.length;
        const latestResponse = assistantMsgs[assistantMsgs.length - 1];
        console.log(
          `[AgentTaskMonitor] New agent response detected for task ${monitor.taskId} (${assistantMsgs.length} msgs, was ${previousCount})`
        );

        await this.handleCompletion(monitor, latestResponse.content);
      }
    } catch (err) {
      console.error(
        `[AgentTaskMonitor] Poll error for session ${sessionKey}:`,
        String(err)
      );
    } finally {
      const refreshed = this.monitors.get(sessionKey);
      if (refreshed) refreshed.checking = false;
    }
  }

  /**
   * Handle successful agent completion — move task to review.
   * Uses completingTasks guard to prevent duplicate transitions.
   */
  private async handleCompletion(
    monitor: ActiveMonitor,
    responseText: string
  ): Promise<void> {
    const { taskId, agentId, sessionKey } = monitor;

    // Atomic guard: prevent duplicate completion processing
    if (completingTasks.has(taskId)) {
      console.log(
        `[AgentTaskMonitor] Task ${taskId} already being completed. Skipping duplicate.`
      );
      this.stopMonitoring(sessionKey);
      return;
    }
    completingTasks.add(taskId);

    try {
      // Stop monitoring first to prevent duplicate processing
      this.stopMonitoring(sessionKey);

      // Verify task still exists and is in_progress
      const task = getTask(taskId);
      if (!task || task.status !== "in_progress") {
        console.log(
          `[AgentTaskMonitor] Task ${taskId} not in expected state (current: ${task?.status}). Skipping.`
        );
        return;
      }

      // Add agent's response as a comment
      if (responseText) {
        addComment({
          id: uuidv4(),
          task_id: taskId,
          agent_id: agentId,
          author_type: "agent",
          content: responseText,
        });
      }

      // Move task to review
      updateTask(taskId, { status: "review" });

      const duration = Math.round((Date.now() - monitor.startedAt) / 1000);
      logActivity({
        id: uuidv4(),
        type: "task_review",
        task_id: taskId,
        agent_id: agentId,
        message: `Agent "${agentId}" completed work on "${task.title}" in ${duration}s — moved to review`,
        metadata: { duration, sessionKey },
      });

      addComment({
        id: uuidv4(),
        task_id: taskId,
        author_type: "system",
        content: `✅ Agent completed in ${duration}s. Task moved to review.`,
      });

      console.log(
        `[AgentTaskMonitor] Task ${taskId} moved to REVIEW (agent completed in ${duration}s)`
      );
    } finally {
      // Release the guard after a delay to prevent immediate re-detection
      setTimeout(() => completingTasks.delete(taskId), 5000);
    }
  }

  /**
   * Force-complete a task (on timeout or error) — move to review.
   * Uses completingTasks guard to prevent duplicate transitions.
   */
  private async forceComplete(
    sessionKey: string,
    reason: "timeout" | "error"
  ): Promise<void> {
    const monitor = this.monitors.get(sessionKey);
    if (!monitor) return;

    const { taskId, agentId } = monitor;

    // Atomic guard: prevent duplicate completion processing
    if (completingTasks.has(taskId)) {
      console.log(
        `[AgentTaskMonitor] Task ${taskId} already being completed. Skipping force-complete.`
      );
      this.stopMonitoring(sessionKey);
      return;
    }
    completingTasks.add(taskId);

    try {
      // Try to get any response before giving up
      let responseText = "";
      try {
        const client = getOpenClawClient();
        const history = await client.getChatHistory(sessionKey);
        const assistantMsgs = history.filter((m) => m.role === "assistant");
        if (assistantMsgs.length > monitor.lastMessageCount) {
          responseText = assistantMsgs[assistantMsgs.length - 1].content;
        }
      } catch {
        // Ignore — we'll move to review anyway
      }

      // Stop monitoring
      this.stopMonitoring(sessionKey);

      const task = getTask(taskId);
      if (!task || task.status !== "in_progress") return;

      if (responseText) {
        addComment({
          id: uuidv4(),
          task_id: taskId,
          agent_id: agentId,
          author_type: "agent",
          content: responseText,
        });
      }

      updateTask(taskId, { status: "review" });

      addComment({
        id: uuidv4(),
        task_id: taskId,
        author_type: "system",
        content:
          reason === "timeout"
            ? "⏱️ Monitor timeout reached. Task moved to review."
            : "⚠️ Monitor error occurred. Task moved to review.",
      });

      logActivity({
        id: uuidv4(),
        type: "task_review",
        task_id: taskId,
        agent_id: agentId,
        message: `Task "${task.title}" moved to review (${reason})`,
      });

      console.log(
        `[AgentTaskMonitor] Task ${taskId} force-moved to REVIEW (${reason})`
      );
    } finally {
      // Release the guard after a delay to prevent immediate re-detection
      setTimeout(() => completingTasks.delete(taskId), 5000);
    }
  }
}

/**
 * Get the singleton AgentTaskMonitor instance.
 */
export function getAgentTaskMonitor(): AgentTaskMonitor {
  if (!globalForMonitor.__agentTaskMonitor) {
    globalForMonitor.__agentTaskMonitor = new AgentTaskMonitor();
  }
  return globalForMonitor.__agentTaskMonitor;
}
