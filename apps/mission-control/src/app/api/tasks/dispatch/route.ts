import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { getAgentTaskMonitor } from "@/lib/agent-task-monitor";
import {
  getTask,
  updateTask,
  addComment,
  logActivity,
  listComments,
} from "@/lib/db";
import { getSpecializedAgent } from "@/lib/agent-registry";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, UserError } from "@/lib/errors";
import { sanitizeInput } from "@/lib/validation";
import { retrySendMessageWithFallback } from "@/lib/model-fallback";
import { dispatchTaskSchema, parseOrThrow } from "@/lib/schemas";
import { buildSpecialistExecutionContext } from "@/lib/specialist-intelligence";

// POST /api/tasks/dispatch - Send a task to an agent for processing
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const { taskId, agentId, feedback, model, provider } = parseOrThrow(
      dispatchTaskSchema,
      await request.json()
    );

    const task = getTask(taskId);
    if (!task) {
      throw new UserError("Task not found", 404);
    }

    // Generate or reuse session key
    // Gateway canonicalizes keys as agent:<agentId>:<sessionKey>
    const sessionKey =
      task.openclaw_session_key ||
      `agent:${agentId}:mission-control:${agentId}:task-${taskId.slice(0, 8)}`;

    // If this is a rework re-dispatch, add the user's feedback as a comment first
    const isRework = !!feedback;
    if (isRework) {
      addComment({
        id: uuidv4(),
        task_id: taskId,
        author_type: "user",
        content: sanitizeInput(feedback!),
      });

      logActivity({
        id: uuidv4(),
        type: "task_rework",
        task_id: taskId,
        agent_id: agentId,
        message: `User requested rework on "${task.title}"`,
      });
    }

    // Update task to assigned → in_progress
    updateTask(taskId, {
      status: "in_progress",
      assigned_agent_id: agentId,
      openclaw_session_key: sessionKey,
    });

    logActivity({
      id: uuidv4(),
      type: isRework ? "task_rework_started" : "task_in_progress",
      task_id: taskId,
      agent_id: agentId,
      message: isRework
        ? `Agent "${agentId}" re-processing "${task.title}" with feedback`
        : `Agent "${agentId}" started working on "${task.title}"`,
      metadata: { sessionKey },
    });

    // Check if this is a specialist agent and get their system prompt
    const specialist = getSpecializedAgent(agentId);
    const adaptiveContext = specialist
      ? buildSpecialistExecutionContext(specialist.id, task.workspace_id)
      : undefined;
    
    // Build the prompt (include specialist context if applicable)
    const prompt = isRework
      ? buildReworkPrompt(
          task,
          sanitizeInput(feedback!),
          taskId,
          specialist?.systemPrompt,
          adaptiveContext
        )
      : buildTaskPrompt(task, specialist?.systemPrompt, adaptiveContext);

    // Connect and send to agent
    const client = getOpenClawClient();
    await client.connect();
    let fallbackModelRef: string | null = null;

    try {
        // If a model override is specified, patch the session before sending
        if (model) {
          const modelRef = provider
            ? `${provider}/${model}`
            : model;
        try {
          await client.patchSession(sessionKey, { model: modelRef });
          console.log(`[dispatch] Set model override: ${modelRef} for session: ${sessionKey}`);
        } catch (patchErr) {
          console.warn(`[dispatch] Failed to set model override: ${patchErr}`);
          // Continue anyway — fall back to default model
        }
      }

      try {
        await client.sendMessage(sessionKey, prompt);
      } catch (sendError) {
        const fallback = await retrySendMessageWithFallback({
          client,
          sessionKey,
          message: prompt,
          originalError: sendError,
          avoidProvider: provider ?? null,
        });
        if (!fallback) {
          throw sendError;
        }
        fallbackModelRef = fallback.modelRef;
      }

      addComment({
        id: uuidv4(),
        task_id: taskId,
        agent_id: agentId,
        author_type: "system",
        content: isRework
          ? `🔄 Rework request sent to agent ${agentId}. Monitoring for completion...${fallbackModelRef ? ` (fallback model: ${fallbackModelRef})` : ""}`
          : `🚀 Task dispatched to agent ${agentId}. Monitoring for completion...${fallbackModelRef ? ` (fallback model: ${fallbackModelRef})` : ""}`,
      });

      // Register with the AgentTaskMonitor for event-driven completion
      const monitor = getAgentTaskMonitor();
      await monitor.startMonitoring(taskId, sessionKey, agentId);

      return NextResponse.json({
        ok: true,
        status: "dispatched",
        sessionKey,
        monitoring: true,
        isRework,
        fallbackModel: fallbackModelRef,
        message: "Task sent to agent. Will auto-move to review when complete.",
      });
    } catch (sendError) {
      addComment({
        id: uuidv4(),
        task_id: taskId,
        agent_id: agentId,
        author_type: "system",
        content: `❌ Failed to send to agent: ${String(sendError)}`,
      });

      // Revert to previous status on send failure
      updateTask(taskId, { status: isRework ? "review" : "inbox" });

      return NextResponse.json(
        {
          ok: false,
          error: "Failed to send task to agent",
          details: String(sendError),
        },
        { status: 502 }
      );
    }
  } catch (error) {
    return handleApiError(error, "Dispatch failed");
  }
}, ApiGuardPresets.write);

function buildExecutionPreflightBlock(): string {
  return `## Execution Preflight

Before changing files or running project commands:
1. Run \`pwd\` and confirm the correct project root.
2. Verify target paths with \`rg --files\` or \`ls\` before \`read\`/\`edit\`.
3. Check available package manager with \`command -v pnpm || command -v npm\` and use what exists.

Package-manager fallback rules:
- Script commands: \`(pnpm <script> || npm run <script>)\`
- Explicit script form: \`(pnpm run <script> || npm run <script>)\`
- Binary execution: \`(pnpm exec <bin> ... || npx <bin> ...)\`

Reliability guardrails:
- Use ASCII hyphen-minus \`-\` for CLI flags (never unicode dashes).
- If browser tools are required, verify browser control service is reachable before relying on it.

---

`;
}

function buildTaskPrompt(
  task: {
    title: string;
    description: string;
    priority: string;
  },
  systemPrompt?: string,
  adaptiveContext?: string
): string {
  const sections = [systemPrompt, adaptiveContext].filter(Boolean);
  const systemContext = sections.length
    ? `## Your Role

${sections.join("\n\n")}

---

`
    : "";
  const executionPreflight = buildExecutionPreflightBlock();

  return `${systemContext}## Task Assignment

**Title:** ${task.title}
**Priority:** ${task.priority.toUpperCase()}

**Description:**
${task.description || "No additional details provided."}

---

${executionPreflight}Please complete this task. Provide a clear, actionable response with your findings or deliverables. Be concise but thorough.`;
}

function buildReworkPrompt(
  task: { title: string; description: string; priority: string },
  feedback: string,
  taskId: string,
  systemPrompt?: string,
  adaptiveContext?: string
): string {
  // Get previous comments for context
  const comments = listComments(taskId);
  const commentHistory = comments
    .filter((c) => c.author_type !== "system")
    .map((c) => {
      const prefix =
        c.author_type === "agent" ? "🤖 Agent" : "👤 User";
      return `${prefix}: ${c.content}`;
    })
    .join("\n\n");

  const sections = [systemPrompt, adaptiveContext].filter(Boolean);
  const systemContext = sections.length
    ? `## Your Role

${sections.join("\n\n")}

---

`
    : "";
  const executionPreflight = buildExecutionPreflightBlock();

  return `${systemContext}## Task Rework Request

**Title:** ${task.title}
**Priority:** ${task.priority.toUpperCase()}

**Original Description:**
${task.description || "No additional details provided."}

---

### Previous Discussion:
${commentHistory || "No previous comments."}

---

### Rework Feedback:
${feedback}

---

${executionPreflight}Please address the feedback above and provide an updated response. Consider all previous discussion context.`;
}
