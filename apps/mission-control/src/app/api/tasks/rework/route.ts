import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getTask, updateTask, addComment, logActivity, listComments } from "@/lib/db";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { getAgentTaskMonitor } from "@/lib/agent-task-monitor";
import { getSpecializedAgent } from "@/lib/agent-registry";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import { retrySendMessageWithFallback } from "@/lib/model-fallback";
import { parseOrThrow, reworkTaskSchema } from "@/lib/schemas";
import { buildSpecialistExecutionContext } from "@/lib/specialist-intelligence";

// --- Prompt builders ---

function buildExecutionPreflightBlock(): string {
  return `## Execution Preflight
- Prefer non-interactive CLI flags (e.g. --yes, --no-input)
- Pipe through head/tail for potentially long outputs
- Always check exit codes
`;
}

function buildReworkPrompt(
  task: { title: string; description?: string | null; priority?: string | null },
  feedback: string,
  comments: { author_type: string; content: string }[],
  systemPrompt?: string,
  adaptiveContext?: string,
): string {
  const commentHistory = comments.length > 0
    ? `### Previous Discussion\n${comments.map((c) => `**${c.author_type}**: ${c.content}`).join("\n\n")}\n\n`
    : "";
  const systemContext = systemPrompt ? `## Specialist Context\n${systemPrompt}\n\n` : "";
  const adaptive = adaptiveContext ? `## Adaptive Context\n${adaptiveContext}\n\n` : "";
  const executionPreflight = buildExecutionPreflightBlock();

  return `${systemContext}${adaptive}## Task Rework Request

**Title:** ${task.title}
${task.description ? `**Description:** ${task.description}\n` : ""}${task.priority ? `**Priority:** ${task.priority}\n` : ""}
${commentHistory}### Rework Feedback
${feedback}

${executionPreflight}
Please address the feedback above and complete the task.`;
}

// POST /api/tasks/rework - Request rework on a task in review
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const { taskId, feedback } = parseOrThrow(
      reworkTaskSchema,
      await request.json(),
    );

    const task = getTask(taskId);
    if (!task) {
      throw new UserError("Task not found", 404);
    }

    if (task.status !== "review") {
      throw new UserError("Task must be in review status to request rework", 400);
    }

    const agentId = task.assigned_agent_id;
    if (!agentId) {
      throw new UserError("Task has no assigned agent for rework", 400);
    }

    const sanitizedFeedback = sanitizeInput(feedback);

    // Add the user's rework feedback as a comment
    addComment({
      id: uuidv4(),
      task_id: taskId,
      author_type: "user",
      content: sanitizedFeedback,
    });

    logActivity({
      id: uuidv4(),
      type: "task_rework",
      task_id: taskId,
      agent_id: agentId,
      message: `Rework requested for "${task.title}"`,
    });

    // Move task back to in_progress
    const sessionKey =
      task.openclaw_session_key ||
      `agent:${agentId}:mission-control:${agentId}:task-${taskId.slice(0, 8)}`;

    updateTask(taskId, {
      status: "in_progress",
      openclaw_session_key: sessionKey,
    });

    // Build rework prompt with specialist context
    const specialist = getSpecializedAgent(agentId);
    const systemPrompt = specialist?.systemPrompt?.slice(0, 7000);
    const adaptiveContext = buildSpecialistExecutionContext(agentId, task.workspace_id);
    const comments = listComments(taskId);

    const prompt = buildReworkPrompt(
      task,
      sanitizedFeedback,
      comments,
      systemPrompt,
      adaptiveContext,
    );

    // Send to agent via gateway (direct call, no internal fetch)
    const client = getOpenClawClient();
    await client.connect();

    try {
      await client.sendMessage(sessionKey, prompt);
    } catch (sendError) {
      // Try fallback model
      const fallbackResult = await retrySendMessageWithFallback({
        client,
        sessionKey,
        message: prompt,
        originalError: sendError,
      });

      if (!fallbackResult) {
        // Revert status on total failure
        updateTask(taskId, { status: "review" });
        throw new UserError("Failed to send rework to agent", 502);
      }
    }

    // Start monitoring for completion
    const monitor = getAgentTaskMonitor();
    await monitor.startMonitoring(taskId, sessionKey, agentId);

    return NextResponse.json({
      ok: true,
      status: "rework_dispatched",
      message: `Rework request sent to agent "${agentId}". Task moved back to in_progress.`,
    });
  } catch (error) {
    return handleApiError(error, "Rework failed");
  }
}, ApiGuardPresets.write);
