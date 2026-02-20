import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { getAgentTaskMonitor } from "@/lib/agent-task-monitor";
import { createTask, updateTask, addComment, logActivity, listTasks } from "@/lib/db";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";
import { retrySendMessageWithFallback } from "@/lib/model-fallback";
import { orchestratorPostSchema, parseOrThrow } from "@/lib/schemas";

/**
 * POST /api/orchestrator — Dispatch multiple tasks to agents in parallel.
 *
 * Body: {
 *   tasks: Array<{ title: string; description: string; priority?: string; agentId: string; model?: string; provider?: string }>
 *   missionName?: string
 * }
 *
 * Creates all tasks in DB, then dispatches them all concurrently.
 */
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const { tasks: taskDefs, missionName, workspace_id } = parseOrThrow(
      orchestratorPostSchema,
      await request.json()
    );

    const batchId = uuidv4().slice(0, 8);
    const client = getOpenClawClient();
    await client.connect();

    const results: Array<{
      taskId: string;
      title: string;
      agentId: string;
      sessionKey: string;
      status: "dispatched" | "failed";
      fallbackModel?: string;
      error?: string;
    }> = [];

    // Create all tasks first
    const createdTasks: Array<{
      id: string;
      title: string;
      description: string;
      priority: string;
      agentId: string;
      model?: string;
      provider?: string;
    }> = [];

    for (const def of taskDefs) {
      const taskId = uuidv4();
      createTask({
        id: taskId,
        title: def.title,
        description: def.description || "",
        priority: def.priority || "medium",
        assigned_agent_id: def.agentId,
        workspace_id,
      });

      createdTasks.push({
        id: taskId,
        title: def.title,
        description: def.description || "",
        priority: def.priority || "medium",
        agentId: def.agentId,
        model: def.model,
        provider: def.provider,
      });
    }

    logActivity({
      id: uuidv4(),
      type: "orchestrator_batch",
      message: `Orchestrator batch "${missionName || batchId}" launched with ${createdTasks.length} tasks`,
      metadata: { batchId, taskCount: createdTasks.length, workspace_id: workspace_id ?? "golden" },
    });

    // Dispatch all tasks in parallel
    const dispatchPromises = createdTasks.map(async (task) => {
      const sessionKey = `agent:${task.agentId}:mission-control:${task.agentId}:orch-${batchId}-${task.id.slice(0, 8)}`;
      let fallbackModelRef: string | null = null;

      try {
        // Update task status
        updateTask(task.id, {
          status: "in_progress",
          openclaw_session_key: sessionKey,
        });

        // Apply model override if specified
        if (task.model) {
          const modelRef = task.provider
            ? `${task.provider}/${task.model}`
            : task.model;
          try {
            await client.patchSession(sessionKey, { model: modelRef });
          } catch {
            // Continue with default model
          }
        }

        // Build and send the prompt
        const prompt = `## Task Assignment (Orchestrator Batch: ${batchId})

**Title:** ${task.title}
**Priority:** ${task.priority.toUpperCase()}

**Description:**
${task.description || "No additional details provided."}

---

Please complete this task. Provide a clear, actionable response with your findings or deliverables. Be concise but thorough.`;

        try {
          await client.sendMessage(sessionKey, prompt);
        } catch (sendError) {
          const fallback = await retrySendMessageWithFallback({
            client,
            sessionKey,
            message: prompt,
            originalError: sendError,
            avoidProvider: task.provider ?? null,
          });
          if (!fallback) {
            throw sendError;
          }
          fallbackModelRef = fallback.modelRef;
        }

        addComment({
          id: uuidv4(),
          task_id: task.id,
          author_type: "system",
          content: `🚀 Dispatched via orchestrator (batch: ${batchId}). Agent: ${task.agentId}${fallbackModelRef ? ` (fallback model: ${fallbackModelRef})` : ""}`,
        });

        logActivity({
          id: uuidv4(),
          type: "task_in_progress",
          task_id: task.id,
          agent_id: task.agentId,
          message: `Agent "${task.agentId}" started "${task.title}" (orchestrator batch)`,
          metadata: { sessionKey, batchId },
        });

        // Start monitoring for completion
        const monitor = getAgentTaskMonitor();
        await monitor.startMonitoring(task.id, sessionKey, task.agentId);

        results.push({
          taskId: task.id,
          title: task.title,
          agentId: task.agentId,
          sessionKey,
          status: "dispatched",
          ...(fallbackModelRef ? { fallbackModel: fallbackModelRef } : {}),
        });
      } catch (err) {
        // Revert task on failure
        updateTask(task.id, { status: "inbox" });

        addComment({
          id: uuidv4(),
          task_id: task.id,
          author_type: "system",
          content: `❌ Dispatch failed: ${String(err)}`,
        });

        results.push({
          taskId: task.id,
          title: task.title,
          agentId: task.agentId,
          sessionKey,
          status: "failed",
          error: String(err),
        });
      }
    });

    await Promise.allSettled(dispatchPromises);

    const dispatched = results.filter((r) => r.status === "dispatched").length;
    const failed = results.filter((r) => r.status === "failed").length;

    return NextResponse.json({
      ok: true,
      batchId,
      total: results.length,
      dispatched,
      failed,
      results,
    });
  } catch (error) {
    return handleApiError(error, "Orchestrator dispatch failed");
  }
}, ApiGuardPresets.expensive);

/**
 * GET /api/orchestrator — Get status of all in-progress orchestrator tasks.
 * Returns tasks with their current status and any agent responses.
 */
export const GET = withApiGuard(async () => {
  try {
    // Get all active monitors
    const monitor = getAgentTaskMonitor();
    const activeMonitors = monitor.getActiveMonitors();

    // Only show orchestrator tasks (session keys contain "orch-")
    const isOrchTask = (sessionKey: string | null) =>
      sessionKey != null && sessionKey.includes(":orch-");

    const inProgress = listTasks({ status: "in_progress" }).filter((t) =>
      isOrchTask(t.openclaw_session_key)
    );
    const inReview = listTasks({ status: "review" }).filter((t) =>
      isOrchTask(t.openclaw_session_key)
    );
    const inDone = listTasks({ status: "done" }).filter((t) =>
      isOrchTask(t.openclaw_session_key)
    );

    // Combine into a status view
    const activeTasks = inProgress.map((task) => {
      const mon = activeMonitors.find((m) => m.taskId === task.id);
      return {
        ...task,
        monitoring: !!mon,
        elapsedMs: mon ? Date.now() - mon.startedAt : undefined,
      };
    });

    // Recent completions — only orchestrator tasks
    const recentCompletions = [...inReview, ...inDone].slice(0, 20);

    return NextResponse.json({
      active: activeTasks,
      completed: recentCompletions,
      monitorCount: activeMonitors.length,
    });
  } catch (error) {
    return handleApiError(error, "Failed to get orchestrator status");
  }
}, ApiGuardPresets.read);
