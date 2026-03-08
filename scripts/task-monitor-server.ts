#!/usr/bin/env bun
/**
 * Task Monitor API Server
 *
 * Standalone HTTP + WebSocket server for real-time task monitoring.
 * Exposes REST API endpoints and WebSocket for live updates.
 *
 * Usage:
 *   bun scripts/task-monitor-server.ts [--port 3847] [--host 0.0.0.0]
 *   TASK_MONITOR_PORT=3847 bun scripts/task-monitor-server.ts
 *
 * API Endpoints:
 *   GET /api/agents                    - List all agents
 *   GET /api/agents/:agentId/tasks     - Get tasks for an agent
 *   GET /api/agents/:agentId/current   - Get current task status
 *   GET /api/agents/:agentId/history   - Get task history
 *   GET /api/agents/:agentId/blocked   - Get blocked tasks with details
 *   GET /api/health                    - Health check
 *
 * WebSocket:
 *   ws://host:port/ws                  - Real-time task change notifications
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { WebSocket, WebSocketServer } from "ws";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_PORT = 3847;
const DEFAULT_HOST = "127.0.0.1";
const TASK_HUB_URL = process.env.TASK_HUB_URL || "http://localhost:3102";
const MILESTONE_POLL_INTERVAL_MS = 30_000;
const TASK_HUB_PROXY_COOKIE = process.env.TASK_HUB_PROXY_COOKIE?.trim() || "";
const TASK_MONITOR_WRITE_TOKEN = process.env.TASK_MONITOR_WRITE_TOKEN?.trim() || "";

// Parse CLI args
function parseArgs(): { port: number; host: string } {
  const args = process.argv.slice(2);
  let port = Number(process.env.TASK_MONITOR_PORT) || DEFAULT_PORT;
  let host = process.env.TASK_MONITOR_HOST || DEFAULT_HOST;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[i + 1];
      i++;
    }
  }

  return { port, host };
}

// ============================================================================
// Types
// ============================================================================

type TaskStatus =
  | "pending"
  | "pending_approval"
  | "in_progress"
  | "blocked"
  | "backlog"
  | "completed"
  | "cancelled"
  | "abandoned";
type TaskPriority = "low" | "medium" | "high" | "urgent";
type EscalationState = "none" | "requesting" | "escalated" | "failed";

interface TaskFile {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  context?: string;
  source?: string;
  created: string;
  lastActivity: string;
  workSessionId?: string;
  previousWorkSessionId?: string;
  progress: string[];
  // Blocked task fields
  blockedReason?: string;
  unblockedBy?: string[];
  unblockedAction?: string;
  unblockRequestCount?: number;
  escalationState?: EscalationState;
  lastUnblockerIndex?: number;
  lastUnblockRequestAt?: string;
  unblockRequestFailures?: number;
  // Backlog task fields
  createdBy?: string;
  assignee?: string;
  dependsOn?: string[];
  estimatedEffort?: string;
  startDate?: string;
  dueDate?: string;
  // Outcome (terminal state)
  outcome?: { kind: string; summary?: string; reason?: string };
  steps?: MonitorTaskStep[];
  stepsProgress?: {
    total: number;
    done: number;
    inProgress: number;
    pending: number;
    skipped: number;
  };
}

interface MonitorTaskStep {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  order: number;
}

interface AgentInfo {
  id: string;
  workspaceDir: string;
  hasCurrentTask: boolean;
  taskCount: number;
}

interface CurrentTaskInfo {
  agentId: string;
  hasTask: boolean;
  content: string | null;
  taskSummary: string | null;
}

interface WsMessage {
  type:
    | "agent_update"
    | "task_update"
    | "task_step_update"
    | "connected"
    | "team_state_update"
    | "event_log"
    | "plan_update"
    | "continuation_event"
    | "coordination_event_new";
  agentId?: string;
  taskId?: string;
  timestamp: string;
  data?: unknown;
}

// ============================================================================
// Paths
// ============================================================================

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const WORKSPACE_PREFIX = "workspace-";
const TASKS_DIR = "tasks";
const TASK_HISTORY_DIR = "task-history";
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";

// Module-level variable for milestone polling
let lastMilestoneHash = "";

// ============================================================================
// Task Parsing (adapted from task-tool.ts)
// ============================================================================

export function parseTaskFileMd(content: string, filename: string): TaskFile | null {
  if (!content || content.includes("*(No task)*")) {
    return null;
  }

  const idMatch = filename.match(/^(task_[a-z0-9_]+)\.md$/);
  const id = idMatch ? idMatch[1] : filename.replace(".md", "");

  const lines = content.split("\n");
  let status: TaskStatus = "pending";
  let priority: TaskPriority = "medium";
  let description = "";
  let context: string | undefined;
  let source: string | undefined;
  let workSessionId: string | undefined;
  let previousWorkSessionId: string | undefined;
  let created = "";
  let lastActivity = "";
  const progress: string[] = [];
  const steps: MonitorTaskStep[] = [];
  // Blocked task fields
  let blockedReason: string | undefined;
  let unblockedBy: string[] | undefined;
  let unblockedAction: string | undefined;
  let unblockRequestCount: number | undefined;
  let escalationState: EscalationState | undefined;
  let lastUnblockerIndex: number | undefined;
  let lastUnblockRequestAt: string | undefined;
  let unblockRequestFailures: number | undefined;
  // Backlog task fields
  let createdBy: string | undefined;
  let assignee: string | undefined;
  let dependsOn: string[] | undefined;
  let estimatedEffort: string | undefined;
  let startDate: string | undefined;
  let dueDate: string | undefined;
  let outcome: { kind: string; summary?: string; reason?: string } | undefined;

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (trimmed.startsWith("# Task:")) {
      continue;
    }

    if (trimmed.startsWith("---") || trimmed.startsWith("*Managed by")) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (currentSection === "metadata") {
      const statusMatch = trimmed.match(/^-?\s*\*\*Status:\*\*\s*(.+)$/);
      if (statusMatch) {
        status = statusMatch[1] as TaskStatus;
      }
      const priorityMatch = trimmed.match(/^-?\s*\*\*Priority:\*\*\s*(.+)$/);
      if (priorityMatch) {
        priority = priorityMatch[1] as TaskPriority;
      }
      const createdMatch = trimmed.match(/^-?\s*\*\*Created:\*\*\s*(.+)$/);
      if (createdMatch) {
        created = createdMatch[1];
      }
      const sourceMatch = trimmed.match(/^-?\s*\*\*Source:\*\*\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1];
      }
      const workSessionMatch = trimmed.match(/^-?\s*\*\*Work Session:\*\*\s*(.+)$/);
      if (workSessionMatch) {
        workSessionId = workSessionMatch[1].trim() || undefined;
      }
      const previousWorkSessionMatch = trimmed.match(
        /^-?\s*\*\*Previous Work Session:\*\*\s*(.+)$/,
      );
      if (previousWorkSessionMatch) {
        previousWorkSessionId = previousWorkSessionMatch[1].trim() || undefined;
      }
      // Blocked task field parsers
      const blockedReasonMatch = trimmed.match(/^-?\s*\*\*Blocked Reason:\*\*\s*(.+)$/);
      if (blockedReasonMatch) {
        blockedReason = blockedReasonMatch[1];
      }
      const unblockedByMatch = trimmed.match(/^-?\s*\*\*Unblocked By:\*\*\s*(.+)$/);
      if (unblockedByMatch) {
        unblockedBy = unblockedByMatch[1]
          .split(/,\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const unblockedActionMatch = trimmed.match(/^-?\s*\*\*Unblocked Action:\*\*\s*(.+)$/);
      if (unblockedActionMatch) {
        unblockedAction = unblockedActionMatch[1];
      }
      const unblockRequestCountMatch = trimmed.match(
        /^-?\s*\*\*Unblock Request Count:\*\*\s*(\d+)$/,
      );
      if (unblockRequestCountMatch) {
        unblockRequestCount = parseInt(unblockRequestCountMatch[1], 10);
      }
      const escalationStateMatch = trimmed.match(/^-?\s*\*\*Escalation State:\*\*\s*(.+)$/);
      if (escalationStateMatch) {
        escalationState = escalationStateMatch[1] as EscalationState;
      }
      const lastUnblockerIndexMatch = trimmed.match(
        /^-?\s*\*\*Last Unblocker Index:\*\*\s*(-?\d+)$/,
      );
      if (lastUnblockerIndexMatch) {
        lastUnblockerIndex = parseInt(lastUnblockerIndexMatch[1], 10);
      }
      const lastUnblockRequestAtMatch = trimmed.match(
        /^-?\s*\*\*Last Unblock Request At:\*\*\s*(.+)$/,
      );
      if (lastUnblockRequestAtMatch) {
        lastUnblockRequestAt = lastUnblockRequestAtMatch[1];
      }
    } else if (currentSection === "description") {
      description = description ? `${description}\n${trimmed}` : trimmed;
    } else if (currentSection === "context") {
      context = context ? `${context}\n${trimmed}` : trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
      }
    } else if (currentSection === "steps") {
      const stepMatch = trimmed.match(/^- \[([x> -])\] \((\w+)\) (.+)$/);
      if (stepMatch) {
        const statusMap: Record<string, MonitorTaskStep["status"]> = {
          x: "done",
          ">": "in_progress",
          " ": "pending",
          "-": "skipped",
        };
        steps.push({
          id: stepMatch[2],
          content: stepMatch[3],
          status: statusMap[stepMatch[1]] || "pending",
          order: steps.length + 1,
        });
      }
    } else if (currentSection === "blocking") {
      // Parse JSON from code block in ## Blocking section
      // Format: ```json\n{...}\n```
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const blockingData = JSON.parse(trimmed);
          if (blockingData.blockedReason) {
            blockedReason = blockingData.blockedReason;
          }
          if (blockingData.unblockedBy) {
            unblockedBy = blockingData.unblockedBy;
          }
          if (blockingData.unblockedAction) {
            unblockedAction = blockingData.unblockedAction;
          }
          if (typeof blockingData.unblockRequestCount === "number") {
            unblockRequestCount = blockingData.unblockRequestCount;
          }
          if (blockingData.escalationState) {
            escalationState = blockingData.escalationState;
          }
          if (typeof blockingData.lastUnblockerIndex === "number") {
            lastUnblockerIndex = blockingData.lastUnblockerIndex;
          }
          if (blockingData.lastUnblockRequestAt) {
            lastUnblockRequestAt = blockingData.lastUnblockRequestAt;
          }
          if (typeof blockingData.unblockRequestFailures === "number") {
            unblockRequestFailures = blockingData.unblockRequestFailures;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    } else if (currentSection === "backlog") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const backlogData = JSON.parse(trimmed);
          if (backlogData.createdBy) {
            createdBy = backlogData.createdBy;
          }
          if (backlogData.assignee) {
            assignee = backlogData.assignee;
          }
          if (backlogData.dependsOn) {
            dependsOn = backlogData.dependsOn;
          }
          if (backlogData.estimatedEffort) {
            estimatedEffort = backlogData.estimatedEffort;
          }
          if (backlogData.startDate) {
            startDate = backlogData.startDate;
          }
          if (backlogData.dueDate) {
            dueDate = backlogData.dueDate;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    } else if (currentSection === "outcome") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const outcomeData = JSON.parse(trimmed);
          if (outcomeData.kind) {
            outcome = outcomeData;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }
  }

  return {
    id,
    status,
    priority,
    description: description || "(no description)",
    context,
    source,
    workSessionId,
    previousWorkSessionId,
    created: created || new Date().toISOString(),
    lastActivity: lastActivity || created || new Date().toISOString(),
    progress,
    blockedReason,
    unblockedBy,
    unblockedAction,
    unblockRequestCount,
    escalationState,
    lastUnblockerIndex,
    lastUnblockRequestAt,
    unblockRequestFailures,
    createdBy,
    assignee,
    dependsOn,
    estimatedEffort,
    startDate,
    dueDate,
    outcome,
    steps: steps.length > 0 ? steps : undefined,
    stepsProgress:
      steps.length > 0
        ? {
            total: steps.length,
            done: steps.filter((s) => s.status === "done").length,
            inProgress: steps.filter((s) => s.status === "in_progress").length,
            pending: steps.filter((s) => s.status === "pending").length,
            skipped: steps.filter((s) => s.status === "skipped").length,
          }
        : undefined,
  };
}

// ============================================================================
// Data Access Functions
// ============================================================================

async function getAgentDirs(): Promise<{ agentId: string; workspaceDir: string }[]> {
  try {
    const entries = await fs.readdir(OPENCLAW_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(WORKSPACE_PREFIX))
      .map((e) => ({
        agentId: e.name.slice(WORKSPACE_PREFIX.length),
        workspaceDir: path.join(OPENCLAW_DIR, e.name),
      }));
  } catch {
    return [];
  }
}

async function getAgentInfo(agentId: string): Promise<AgentInfo | null> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  try {
    await fs.access(workspaceDir);
  } catch {
    return null;
  }

  let hasCurrentTask = false;
  let taskCount = 0;

  // Check current task
  const currentTaskPath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  try {
    const content = await fs.readFile(currentTaskPath, "utf-8");
    hasCurrentTask =
      !content.includes("No task in progress") && !content.includes("No active focus");
  } catch {
    // No current task file
  }

  // Count tasks
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  try {
    const files = await fs.readdir(tasksDir);
    taskCount = files.filter((f) => f.startsWith("task_") && f.endsWith(".md")).length;
  } catch {
    // No tasks directory
  }

  return { id: agentId, workspaceDir, hasCurrentTask, taskCount };
}

async function listAgents(): Promise<AgentInfo[]> {
  const agentDirs = await getAgentDirs();
  const agents: AgentInfo[] = [];

  for (const { agentId } of agentDirs) {
    const info = await getAgentInfo(agentId);
    if (info) {
      agents.push(info);
    }
  }

  return agents;
}

async function getCurrentTask(agentId: string): Promise<CurrentTaskInfo> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  const currentTaskPath = path.join(workspaceDir, CURRENT_TASK_FILENAME);

  try {
    const content = await fs.readFile(currentTaskPath, "utf-8");
    const hasTask =
      !content.includes("No task in progress") && !content.includes("No active focus");

    // Extract summary from content
    let taskSummary: string | null = null;
    if (hasTask) {
      const taskMatch = content.match(/\*\*Task:\*\*\s*(.+)/);
      const focusMatch = content.match(/\*\*Focus:\*\*\s*(.+)/);
      taskSummary = taskMatch?.[1] || focusMatch?.[1] || null;
    }

    return { agentId, hasTask, content, taskSummary };
  } catch {
    return { agentId, hasTask: false, content: null, taskSummary: null };
  }
}

async function listTasks(agentId: string, statusFilter?: TaskStatus): Promise<TaskFile[]> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  const tasks: TaskFile[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(tasksDir);
  } catch {
    return tasks;
  }

  for (const file of files) {
    if (!file.endsWith(".md") || !file.startsWith("task_")) {
      continue;
    }
    try {
      const filePath = path.join(tasksDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFileMd(content, file);
      if (task) {
        if (!statusFilter || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    } catch {
      // File may have been deleted between readdir and readFile
    }
  }

  // Sort by priority then creation time
  const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return new Date(b.created).getTime() - new Date(a.created).getTime();
  });

  return tasks;
}

async function getTaskById(agentId: string, taskId: string): Promise<TaskFile | null> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);

  // 1. Check active tasks directory first
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  const taskFilePath = path.join(tasksDir, `${taskId}.md`);
  try {
    const content = await fs.readFile(taskFilePath, "utf-8");
    const task = parseTaskFileMd(content, `${taskId}.md`);
    if (task) {
      return task;
    }
  } catch {
    // Not in active tasks, check history
  }

  // 2. Fallback: search task-history files
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  try {
    const files = await fs.readdir(historyDir);
    const monthFiles = files
      .filter((f: string) => /^\d{4}-\d{2}\.md$/.test(f))
      .toSorted()
      .toReversed();

    for (const monthFile of monthFiles) {
      const historyPath = path.join(historyDir, monthFile);
      const content = await fs.readFile(historyPath, "utf-8");

      // Split into entries and search for matching task ID
      const entries = content.split(/(?=^## \[)/m);
      for (const entry of entries) {
        const taskIdMatch = entry.match(/\*\*Task ID:\*\*\s*(task_[a-z0-9_]+)/);
        if (taskIdMatch && taskIdMatch[1] === taskId) {
          // Parse completed task from history entry
          const statusMatch = entry.match(/\*\*Completed:\*\*\s*(.+)/);
          const priorityMatch = entry.match(/\*\*Priority:\*\*\s*(.+)/);
          const startedMatch = entry.match(/\*\*Started:\*\*\s*(.+)/);
          const titleMatch = entry.match(/^## \[.+?\]\s*(.+)$/m);
          const summaryMatch = entry.match(/### Summary\n([\s\S]*?)(?=\n---|\n## |$)/);

          const progressLines: string[] = [];
          const progressSection = entry.match(/### Progress\n([\s\S]*?)(?=\n### |$)/);
          if (progressSection) {
            const pLines = progressSection[1].split("\n");
            for (const pl of pLines) {
              const trimmed = pl.trim();
              if (trimmed.startsWith("- ")) {
                progressLines.push(trimmed.slice(2));
              }
            }
          }

          return {
            id: taskId,
            status: "completed" as TaskStatus,
            priority: (priorityMatch?.[1]?.trim() || "medium") as TaskPriority,
            description: titleMatch?.[1]?.trim() || "(no description)",
            context: summaryMatch?.[1]?.trim(),
            source: "history",
            created: startedMatch?.[1]?.trim() || "",
            lastActivity: statusMatch?.[1]?.trim() || "",
            progress: progressLines,
          };
        }
      }
    }
  } catch {
    // No history directory
  }

  return null;
}

async function getTaskHistory(
  agentId: string,
  options: { limit?: number; month?: string } = {},
): Promise<{ entries: string; months: string[] }> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  const limit = options.limit ?? 50;

  let months: string[] = [];
  try {
    const files = await fs.readdir(historyDir);
    months = files
      .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(".md", ""))
      .toSorted()
      .toReversed();
  } catch {
    return { entries: "", months: [] };
  }

  if (months.length === 0) {
    return { entries: "", months: [] };
  }

  const targetMonth = options.month || months[0];
  const historyPath = path.join(historyDir, `${targetMonth}.md`);

  try {
    const content = await fs.readFile(historyPath, "utf-8");
    const entries = content.split(/(?=^## \[)/m);
    return { entries: entries.slice(-limit).join(""), months };
  } catch {
    return { entries: "", months };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = (hash << 5) - hash + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("::ffff:127.")
  );
}

function isAuthorizedWriteRequest(req: http.IncomingMessage): boolean {
  if (TASK_MONITOR_WRITE_TOKEN) {
    const provided = String(req.headers["x-task-monitor-token"] || "").trim();
    return provided.length > 0 && provided === TASK_MONITOR_WRITE_TOKEN;
  }
  return isLoopbackAddress(req.socket.remoteAddress);
}

function normalizeTeamState(rawState: unknown): {
  version: number;
  agents: Record<string, unknown>;
  lastUpdatedMs: number;
} {
  const state =
    rawState && typeof rawState === "object" ? (rawState as Record<string, unknown>) : {};
  const lastUpdatedMsRaw = state.lastUpdatedMs;
  const updatedAtRaw = state.updatedAt;
  const lastUpdatedMs =
    typeof lastUpdatedMsRaw === "number" && Number.isFinite(lastUpdatedMsRaw)
      ? lastUpdatedMsRaw
      : typeof updatedAtRaw === "string"
        ? new Date(updatedAtRaw).getTime() || 0
        : 0;

  return {
    version:
      typeof state.version === "number" && Number.isFinite(state.version) ? state.version : 1,
    agents:
      state.agents && typeof state.agents === "object"
        ? (state.agents as Record<string, unknown>)
        : {},
    lastUpdatedMs,
  };
}

function buildTaskHubCookieHeader(req?: http.IncomingMessage): string | null {
  const forwarded = String(req?.headers.cookie || "").trim();
  if (forwarded) {
    return forwarded;
  }
  if (TASK_HUB_PROXY_COOKIE) {
    return TASK_HUB_PROXY_COOKIE;
  }
  return null;
}

// readLastCoordinationEvent removed — replaced by EventCache.onFileChange() (Design #2)

// ============================================================================
// Event Classification (Role + Category)
// ============================================================================

export type EventRole =
  | "conversation.main"
  | "delegation.subagent"
  | "orchestration.task"
  | "system.observability";

export type SessionType = "main" | "subagent" | "unknown";

export type CollaborationCategory =
  | "engineering_build"
  | "infra_ops"
  | "qa_validation"
  | "planning_decision"
  | "research_analysis"
  | "docs_knowledge"
  | "growth_marketing"
  | "customer_community"
  | "legal_compliance"
  | "biz_strategy";

export const COLLABORATION_CATEGORIES: CollaborationCategory[] = [
  "engineering_build",
  "infra_ops",
  "qa_validation",
  "planning_decision",
  "research_analysis",
  "docs_knowledge",
  "growth_marketing",
  "customer_community",
  "legal_compliance",
  "biz_strategy",
];

type EnrichedCoordinationEvent = Record<string, unknown> & {
  type: string;
  data: Record<string, unknown>;
  eventRole: EventRole;
  fromSessionType: SessionType;
  toSessionType: SessionType;
  collabCategory: CollaborationCategory;
  collabSubTags: string[];
  categoryConfidence: number;
  categorySource: "manual" | "rule" | "heuristic" | "fallback";
};

export type WorkSessionStatus = "ACTIVE" | "QUIET" | "ARCHIVED";

type WorkSessionCategoryOverride = {
  collabCategory: CollaborationCategory;
  updatedAt: string;
  updatedBy?: string;
};

type WorkSessionCategoryOverrideMap = Record<string, WorkSessionCategoryOverride>;

export type WorkSessionThreadSummary = {
  id: string;
  conversationId?: string;
  fromAgent: string;
  toAgent: string;
  startTime: number;
  lastTime: number;
  eventCount: number;
  collabCategory: CollaborationCategory;
  collabSubTags: string[];
  events: EnrichedCoordinationEvent[];
};

export type WorkSessionSummary = {
  id: string;
  workSessionId: string;
  status: WorkSessionStatus;
  startTime: number;
  lastTime: number;
  durationMs: number;
  threadCount: number;
  eventCount: number;
  collabCategory: CollaborationCategory;
  collabSubTags: string[];
  categorySource: "manual_override" | "event";
  roleCounts: Record<EventRole, number>;
  threads: WorkSessionThreadSummary[];
};

const WORK_SESSION_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const WORK_SESSION_CATEGORY_OVERRIDES_PATH = path.join(
  OPENCLAW_DIR,
  "work-session-category-overrides.json",
);

let mainAgentCache: { mtimeMs: number; ids: Set<string> } | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asCollaborationCategory(value: unknown): CollaborationCategory | undefined {
  const candidate = asString(value);
  if (!candidate) {
    return undefined;
  }
  return COLLABORATION_CATEGORIES.includes(candidate as CollaborationCategory)
    ? (candidate as CollaborationCategory)
    : undefined;
}

function normalizeAgentId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function resolveMainAgentIdsFromConfig(parsed: unknown): Set<string> {
  const record = asRecord(parsed);
  const agents = asRecord(record.agents);
  const ids = new Set<string>();

  // Preferred schema: agents.list: [{ id: "..." }]
  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const entry of list) {
    const id = normalizeAgentId(asString(asRecord(entry).id));
    if (id) {
      ids.add(id);
    }
  }

  // Backward compatibility for map-like agents objects.
  for (const [key, value] of Object.entries(agents)) {
    if (key === "list" || key === "defaults") {
      continue;
    }
    const valueRecord = asRecord(value);
    const explicitId = normalizeAgentId(asString(valueRecord.id));
    if (explicitId) {
      ids.add(explicitId);
      continue;
    }
    if (Object.keys(valueRecord).length > 0) {
      const keyAsId = normalizeAgentId(key);
      if (keyAsId) {
        ids.add(keyAsId);
      }
    }
  }

  ids.add("main");
  ids.add("ruda");
  return ids;
}

function resolveMainAgentIds(): Set<string> {
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
  try {
    const stat = fsSync.statSync(configPath);
    if (mainAgentCache && mainAgentCache.mtimeMs === stat.mtimeMs) {
      return mainAgentCache.ids;
    }
    const raw = fsSync.readFileSync(configPath, "utf-8");
    const ids = resolveMainAgentIdsFromConfig(parseJsonSafe(raw));
    mainAgentCache = { mtimeMs: stat.mtimeMs, ids };
    return ids;
  } catch {
    return new Set(["main", "ruda"]);
  }
}

function isMainAgentId(agentId: string | undefined, mainAgents: Set<string>): boolean {
  const normalized = normalizeAgentId(agentId);
  return !!(normalized && mainAgents.has(normalized));
}

function sessionTypeFromSessionKey(sessionKey: string | undefined): SessionType {
  if (!sessionKey) {
    return "unknown";
  }
  if (sessionKey.includes(":subagent:")) {
    return "subagent";
  }
  if (/^agent:[^:]+:main$/i.test(sessionKey)) {
    return "main";
  }
  return "unknown";
}

function orchestrationType(type: string): boolean {
  return (
    type.startsWith("task.") ||
    type.startsWith("continuation.") ||
    type.startsWith("plan.") ||
    type.startsWith("unblock.") ||
    type.startsWith("zombie.") ||
    type.startsWith("resume_reminder.") ||
    type.startsWith("backlog.")
  );
}

function deriveSessionTypes(params: {
  eventType: string;
  data: Record<string, unknown>;
  fromAgent?: string;
  toAgent?: string;
  mainAgents: Set<string>;
}): { fromSessionType: SessionType; toSessionType: SessionType } {
  const explicitFrom = asString(params.data.fromSessionType);
  const explicitTo = asString(params.data.toSessionType);

  if (
    (explicitFrom === "main" || explicitFrom === "subagent" || explicitFrom === "unknown") &&
    (explicitTo === "main" || explicitTo === "subagent" || explicitTo === "unknown")
  ) {
    return {
      fromSessionType: explicitFrom as SessionType,
      toSessionType: explicitTo as SessionType,
    };
  }

  const targetSessionKey = asString(params.data.targetSessionKey);
  const sourceSessionKey =
    asString(params.data.sourceSessionKey) ||
    asString(params.data.requesterSessionKey) ||
    asString(params.data.sessionKey);

  let fromSessionType = sessionTypeFromSessionKey(sourceSessionKey);
  let toSessionType = sessionTypeFromSessionKey(targetSessionKey);

  if (params.eventType === "a2a.spawn" || params.eventType === "a2a.spawn_result") {
    fromSessionType = "main";
    toSessionType = "subagent";
  }

  const hasDelegationHint =
    asString(params.data.parentConversationId) !== undefined ||
    asNumber(params.data.depth) !== undefined ||
    asNumber(params.data.hop) !== undefined;

  if (fromSessionType === "unknown") {
    if (isMainAgentId(params.fromAgent, params.mainAgents)) {
      fromSessionType = "main";
    } else if (hasDelegationHint && isMainAgentId(params.toAgent, params.mainAgents)) {
      fromSessionType = "subagent";
    }
  }

  if (toSessionType === "unknown") {
    if (isMainAgentId(params.toAgent, params.mainAgents)) {
      toSessionType = "main";
    } else if (hasDelegationHint && isMainAgentId(params.fromAgent, params.mainAgents)) {
      toSessionType = "subagent";
    }
  }

  return { fromSessionType, toSessionType };
}

function deriveEventRole(params: {
  eventType: string;
  data: Record<string, unknown>;
  fromAgent?: string;
  toAgent?: string;
  fromSessionType: SessionType;
  toSessionType: SessionType;
  mainAgents: Set<string>;
}): EventRole {
  const explicit = asString(params.data.eventRole);
  if (
    explicit === "conversation.main" ||
    explicit === "delegation.subagent" ||
    explicit === "orchestration.task" ||
    explicit === "system.observability"
  ) {
    return explicit;
  }

  if (orchestrationType(params.eventType)) {
    return "orchestration.task";
  }

  if (params.eventType === "milestone.sync_failed") {
    return "system.observability";
  }

  if (params.eventType.startsWith("a2a.")) {
    const delegationHint =
      params.eventType === "a2a.spawn" ||
      params.eventType === "a2a.spawn_result" ||
      asString(params.data.parentConversationId) !== undefined ||
      asNumber(params.data.depth) !== undefined ||
      asNumber(params.data.hop) !== undefined ||
      params.fromSessionType === "subagent" ||
      params.toSessionType === "subagent";

    if (delegationHint) {
      return "delegation.subagent";
    }

    const bothMain = params.fromSessionType === "main" && params.toSessionType === "main";

    return bothMain ? "conversation.main" : "delegation.subagent";
  }

  return "system.observability";
}

const CATEGORY_KEYWORDS: Record<CollaborationCategory, string[]> = {
  engineering_build: [
    "implement",
    "implementation",
    "build",
    "feature",
    "refactor",
    "bugfix",
    "fix",
    "코드",
    "구현",
    "개발",
    "리팩토링",
    "버그",
  ],
  infra_ops: [
    "deploy",
    "deployment",
    "infra",
    "infrastructure",
    "docker",
    "k8s",
    "ops",
    "incident",
    "운영",
    "인프라",
    "배포",
    "장애",
    "서버",
  ],
  qa_validation: [
    "test",
    "testing",
    "qa",
    "validation",
    "verify",
    "e2e",
    "회귀",
    "검증",
    "테스트",
    "품질",
  ],
  planning_decision: [
    "plan",
    "planning",
    "decision",
    "design",
    "architecture",
    "scope",
    "우선순위",
    "설계",
    "기획",
    "의사결정",
    "정책",
  ],
  research_analysis: [
    "research",
    "analysis",
    "investigate",
    "compare",
    "benchmark",
    "root cause",
    "분석",
    "조사",
    "리서치",
    "원인",
    "비교",
  ],
  docs_knowledge: [
    "doc",
    "docs",
    "documentation",
    "guide",
    "readme",
    "wiki",
    "문서",
    "가이드",
    "정리",
    "기록",
  ],
  growth_marketing: [
    "campaign",
    "marketing",
    "growth",
    "experiment",
    "copy",
    "funnel",
    "마케팅",
    "성장",
    "캠페인",
    "전환",
  ],
  customer_community: [
    "customer",
    "community",
    "support",
    "ticket",
    "feedback",
    "cs",
    "고객",
    "커뮤니티",
    "문의",
    "피드백",
  ],
  legal_compliance: [
    "legal",
    "compliance",
    "policy",
    "terms",
    "regulation",
    "contract",
    "법무",
    "컴플라이언스",
    "약관",
    "규정",
    "계약",
  ],
  biz_strategy: [
    "kpi",
    "revenue",
    "strategy",
    "business",
    "roadmap",
    "roi",
    "비즈니스",
    "전략",
    "지표",
    "매출",
  ],
};

function eventTextCandidates(eventType: string, data: Record<string, unknown>): string[] {
  const candidates: string[] = [eventType];
  const keys = [
    "label",
    "message",
    "replyPreview",
    "description",
    "summary",
    "reason",
    "title",
    "taskId",
    "workSessionId",
    "collabIntent",
  ];
  for (const key of keys) {
    const value = asString(data[key]);
    if (value) {
      candidates.push(value);
    }
  }
  return candidates;
}

function fallbackCategoryByRole(role: EventRole): CollaborationCategory {
  if (role === "orchestration.task") {
    return "planning_decision";
  }
  if (role === "system.observability") {
    return "infra_ops";
  }
  return "engineering_build";
}

function classifyCollaborationCategory(params: {
  role: EventRole;
  eventType: string;
  data: Record<string, unknown>;
}): {
  collabCategory: CollaborationCategory;
  collabSubTags: string[];
  categoryConfidence: number;
  categorySource: "manual" | "rule" | "heuristic" | "fallback";
  collabIntent?: string;
} {
  const explicit = asString(params.data.collabCategory);
  if (explicit && COLLABORATION_CATEGORIES.includes(explicit as CollaborationCategory)) {
    const explicitSubTags = Array.isArray(params.data.collabSubTags)
      ? (params.data.collabSubTags as unknown[])
          .map((value) => asString(value))
          .filter((value): value is string => !!value)
          .slice(0, 5)
      : [];
    return {
      collabCategory: explicit as CollaborationCategory,
      collabSubTags: explicitSubTags,
      categoryConfidence: 1,
      categorySource: "manual",
      collabIntent: asString(params.data.collabIntent),
    };
  }

  const haystack = eventTextCandidates(params.eventType, params.data).join("\n").toLowerCase();
  const scores = new Map<CollaborationCategory, { score: number; hits: string[] }>();

  for (const category of COLLABORATION_CATEGORIES) {
    const hits: string[] = [];
    let score = 0;
    for (const keyword of CATEGORY_KEYWORDS[category]) {
      if (haystack.includes(keyword.toLowerCase())) {
        hits.push(keyword);
        score += keyword.length > 4 ? 2 : 1;
      }
    }
    scores.set(category, { score, hits });
  }

  const ranked = [...scores.entries()].toSorted((a, b) => b[1].score - a[1].score);
  const [topCategory, topScoreEntry] = ranked[0];
  const secondScore = ranked[1]?.[1]?.score ?? 0;

  if (topScoreEntry.score > 0) {
    const gap = Math.max(0, topScoreEntry.score - secondScore);
    const confidence = Math.min(0.95, 0.5 + topScoreEntry.score * 0.08 + gap * 0.05);
    return {
      collabCategory: topCategory,
      collabSubTags: topScoreEntry.hits.slice(0, 3),
      categoryConfidence: Number(confidence.toFixed(2)),
      categorySource: "rule",
      collabIntent: asString(params.data.collabIntent),
    };
  }

  return {
    collabCategory: fallbackCategoryByRole(params.role),
    collabSubTags: [],
    categoryConfidence: 0.2,
    categorySource: "fallback",
    collabIntent: asString(params.data.collabIntent),
  };
}

export function enrichCoordinationEvent(rawEvent: unknown): EnrichedCoordinationEvent | null {
  const record = asRecord(rawEvent);
  const type = asString(record.type);
  if (!type) {
    return null;
  }

  const data = asRecord(record.data);
  const fromAgent =
    asString(data.fromAgent) || asString(data.senderAgentId) || asString(record.agentId);
  const toAgent = asString(data.toAgent) || asString(data.targetAgentId);
  const mainAgents = resolveMainAgentIds();

  const { fromSessionType, toSessionType } = deriveSessionTypes({
    eventType: type,
    data,
    fromAgent,
    toAgent,
    mainAgents,
  });

  const eventRole = deriveEventRole({
    eventType: type,
    data,
    fromAgent,
    toAgent,
    fromSessionType,
    toSessionType,
    mainAgents,
  });

  const category = classifyCollaborationCategory({ role: eventRole, eventType: type, data });

  const enrichedData: Record<string, unknown> = {
    ...data,
    eventRole,
    fromSessionType,
    toSessionType,
    collabCategory: category.collabCategory,
    collabSubTags: category.collabSubTags,
    collabIntent: category.collabIntent,
    categoryConfidence: category.categoryConfidence,
    categorySource: category.categorySource,
    categoryVersion: asString(data.categoryVersion) || "v1",
  };

  return {
    ...record,
    type,
    data: enrichedData,
    eventRole,
    fromSessionType,
    toSessionType,
    collabCategory: category.collabCategory,
    collabSubTags: category.collabSubTags,
    categoryConfidence: category.categoryConfidence,
    categorySource: category.categorySource,
  };
}

function coordinationEventTimestampMs(event: Record<string, unknown>): number {
  const numericTs = asNumber(event.timestampMs) || asNumber(event.ts);
  if (numericTs) {
    return numericTs;
  }
  const isoTs = asString(event.timestamp);
  return isoTs ? new Date(isoTs).getTime() || 0 : 0;
}

function eventRoleFromValue(value: unknown): EventRole | null {
  return value === "conversation.main" ||
    value === "delegation.subagent" ||
    value === "orchestration.task" ||
    value === "system.observability"
    ? value
    : null;
}

function normalizeRoleFilters(value: Iterable<EventRole> | undefined): Set<EventRole> | undefined {
  if (!value) {
    return undefined;
  }
  const allowed = new Set<EventRole>();
  for (const role of value) {
    const normalized = eventRoleFromValue(role);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  return allowed.size > 0 ? allowed : undefined;
}

function normalizeEventTypeFilters(value: Iterable<string> | undefined): Set<string> | undefined {
  if (!value) {
    return undefined;
  }
  const allowed = new Set<string>();
  for (const item of value) {
    const normalized = asString(item);
    if (normalized) {
      allowed.add(normalized);
    }
  }
  return allowed.size > 0 ? allowed : undefined;
}

function parseCsvQueryParam(url: URL, key: string): string[] {
  return url.searchParams
    .getAll(key)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCoordinationEventsFromRaw(raw: string): {
  lines: string[];
  events: EnrichedCoordinationEvent[];
  pendingLineFragment: string;
} {
  const rawLines = raw.split("\n");
  const trailingLine = raw.endsWith("\n") || rawLines.length === 0 ? "" : (rawLines.pop() ?? "");
  const lines = rawLines.map((line) => line.trim()).filter(Boolean);

  const events = lines
    .map((line) => {
      try {
        return enrichCoordinationEvent(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((event): event is EnrichedCoordinationEvent => !!event);

  return { lines, events, pendingLineFragment: trailingLine };
}

function nextWorkSessionCacheExpiryMs(sessions: WorkSessionSummary[]): number {
  let nextExpiryMs = Number.POSITIVE_INFINITY;

  for (const session of sessions) {
    if (session.status === "ARCHIVED") {
      continue;
    }

    nextExpiryMs = Math.min(nextExpiryMs, session.lastTime + WORK_SESSION_ARCHIVE_WINDOW_MS + 1);
  }

  return nextExpiryMs;
}

function workSessionThreadKey(event: EnrichedCoordinationEvent, eventTs: number): string {
  const data = asRecord(event.data);
  const conversationId = asString(data.conversationId);
  if (conversationId) {
    return `conv:${conversationId}`;
  }

  const fromAgent =
    asString(data.fromAgent) ||
    asString(data.senderAgentId) ||
    asString(event.agentId) ||
    "unknown";
  const toAgent = asString(data.toAgent) || asString(data.targetAgentId) || "unknown";
  const pair = [fromAgent, toAgent].toSorted().join("_");
  if (pair !== "unknown_unknown") {
    return `pair:${pair}`;
  }

  // Fallback bucket for malformed legacy events that have neither pair nor conversationId.
  return `event:${event.type}:${Math.floor(eventTs / (5 * 60 * 1000))}`;
}

function isTerminalWorkSessionEvent(event: EnrichedCoordinationEvent): boolean {
  if (event.type === "a2a.complete") {
    return true;
  }

  if (event.type === "a2a.spawn_result") {
    const status = asString(asRecord(event.data).status);
    if (status === "error") {
      return true;
    }
  }

  if (event.type === "continuation.complete" || event.type === "continuation.completed") {
    return true;
  }

  if (event.type.startsWith("task.")) {
    const status =
      asString(asRecord(event.data).status) ||
      asString(event.status) ||
      asString(asRecord(event).status);
    if (
      status === "completed" ||
      status === "cancelled" ||
      status === "abandoned" ||
      status === "failed"
    ) {
      return true;
    }
  }

  return false;
}

type BuildWorkSessionsOptions = {
  nowMs?: number;
  categoryOverrides?: WorkSessionCategoryOverrideMap;
  roleFilters?: Iterable<EventRole>;
  eventTypeFilters?: Iterable<string>;
};

export function buildWorkSessionsFromEvents(
  events: EnrichedCoordinationEvent[],
  options: BuildWorkSessionsOptions = {},
): WorkSessionSummary[] {
  const nowMs = options.nowMs ?? Date.now();
  const allowedRoles = normalizeRoleFilters(options.roleFilters);
  const allowedEventTypes = normalizeEventTypeFilters(options.eventTypeFilters);

  const workSessions = new Map<
    string,
    {
      workSessionId: string;
      startTime: number;
      lastTime: number;
      eventCount: number;
      collabCategory: CollaborationCategory;
      collabSubTags: string[];
      latestEvent: EnrichedCoordinationEvent | null;
      roleCounts: Record<EventRole, number>;
      threads: Map<string, WorkSessionThreadSummary>;
    }
  >();

  const sortedEvents = [...events].toSorted(
    (a, b) => coordinationEventTimestampMs(a) - coordinationEventTimestampMs(b),
  );

  for (const event of sortedEvents) {
    if (allowedEventTypes && !allowedEventTypes.has(event.type)) {
      continue;
    }
    const data = asRecord(event.data);
    const role = eventRoleFromValue(event.eventRole) || eventRoleFromValue(data.eventRole);
    if (allowedRoles && (!role || !allowedRoles.has(role))) {
      continue;
    }
    const workSessionId = asString(data.workSessionId);
    if (!workSessionId) {
      continue;
    }

    const eventTs = coordinationEventTimestampMs(event);
    const eventCategory =
      asCollaborationCategory(event.collabCategory) ||
      asCollaborationCategory(data.collabCategory) ||
      "engineering_build";
    const eventSubTagsRaw =
      (Array.isArray(event.collabSubTags) ? event.collabSubTags : undefined) ||
      (Array.isArray(data.collabSubTags) ? data.collabSubTags : undefined) ||
      [];
    const eventSubTags = eventSubTagsRaw
      .map((value) => asString(value))
      .filter((value): value is string => !!value)
      .slice(0, 5);

    if (!workSessions.has(workSessionId)) {
      workSessions.set(workSessionId, {
        workSessionId,
        startTime: eventTs,
        lastTime: eventTs,
        eventCount: 0,
        collabCategory: eventCategory,
        collabSubTags: [...eventSubTags],
        latestEvent: event,
        roleCounts: {
          "conversation.main": 0,
          "delegation.subagent": 0,
          "orchestration.task": 0,
          "system.observability": 0,
        },
        threads: new Map<string, WorkSessionThreadSummary>(),
      });
    }

    const aggregate = workSessions.get(workSessionId)!;
    aggregate.startTime = Math.min(aggregate.startTime, eventTs);
    aggregate.lastTime = Math.max(aggregate.lastTime, eventTs);
    aggregate.eventCount += 1;

    if (
      !aggregate.latestEvent ||
      coordinationEventTimestampMs(aggregate.latestEvent) <= coordinationEventTimestampMs(event)
    ) {
      aggregate.latestEvent = event;
    }

    if (aggregate.collabCategory === "engineering_build" && eventCategory !== "engineering_build") {
      aggregate.collabCategory = eventCategory;
    }
    if (aggregate.collabSubTags.length === 0 && eventSubTags.length > 0) {
      aggregate.collabSubTags = [...eventSubTags];
    }

    if (role) {
      aggregate.roleCounts[role] += 1;
    }

    const threadId = workSessionThreadKey(event, eventTs);
    if (!aggregate.threads.has(threadId)) {
      const fromAgent =
        asString(data.fromAgent) ||
        asString(data.senderAgentId) ||
        asString(event.agentId) ||
        "unknown";
      const toAgent = asString(data.toAgent) || asString(data.targetAgentId) || "unknown";
      aggregate.threads.set(threadId, {
        id: threadId,
        conversationId: asString(data.conversationId),
        fromAgent,
        toAgent,
        startTime: eventTs,
        lastTime: eventTs,
        eventCount: 0,
        collabCategory: eventCategory,
        collabSubTags: [...eventSubTags],
        events: [],
      });
    }

    const thread = aggregate.threads.get(threadId)!;
    thread.startTime = Math.min(thread.startTime, eventTs);
    thread.lastTime = Math.max(thread.lastTime, eventTs);
    thread.eventCount += 1;
    if (!thread.conversationId) {
      thread.conversationId = asString(data.conversationId);
    }
    if (thread.collabCategory === "engineering_build" && eventCategory !== "engineering_build") {
      thread.collabCategory = eventCategory;
    }
    if (thread.collabSubTags.length === 0 && eventSubTags.length > 0) {
      thread.collabSubTags = [...eventSubTags];
    }
    thread.events.push(event);
  }

  const summaries: WorkSessionSummary[] = [];

  for (const aggregate of workSessions.values()) {
    const override = options.categoryOverrides?.[aggregate.workSessionId];
    const inactiveMs = nowMs - aggregate.lastTime;

    let status: WorkSessionStatus;
    if (inactiveMs > WORK_SESSION_ARCHIVE_WINDOW_MS) {
      status = "ARCHIVED";
    } else if (aggregate.latestEvent && isTerminalWorkSessionEvent(aggregate.latestEvent)) {
      status = "QUIET";
    } else {
      status = "ACTIVE";
    }

    const threads = [...aggregate.threads.values()]
      .map((thread) => ({
        ...thread,
        events: [...thread.events].toSorted(
          (a, b) => coordinationEventTimestampMs(a) - coordinationEventTimestampMs(b),
        ),
      }))
      .toSorted((a, b) => b.lastTime - a.lastTime);

    summaries.push({
      id: `ws:${aggregate.workSessionId}`,
      workSessionId: aggregate.workSessionId,
      status,
      startTime: aggregate.startTime,
      lastTime: aggregate.lastTime,
      durationMs: Math.max(0, aggregate.lastTime - aggregate.startTime),
      threadCount: threads.length,
      eventCount: aggregate.eventCount,
      collabCategory: override?.collabCategory || aggregate.collabCategory,
      collabSubTags: aggregate.collabSubTags,
      categorySource: override ? "manual_override" : "event",
      roleCounts: aggregate.roleCounts,
      threads,
    });
  }

  return summaries.toSorted((a, b) => b.lastTime - a.lastTime);
}

async function readWorkSessionCategoryOverrides(): Promise<WorkSessionCategoryOverrideMap> {
  try {
    const raw = await fs.readFile(WORK_SESSION_CATEGORY_OVERRIDES_PATH, "utf-8");
    const parsed = parseJsonSafe(raw);
    const record = asRecord(parsed);
    const result: WorkSessionCategoryOverrideMap = {};

    for (const [workSessionId, value] of Object.entries(record)) {
      const entry = asRecord(value);
      const collabCategory = asCollaborationCategory(entry.collabCategory);
      if (!collabCategory) {
        continue;
      }
      result[workSessionId] = {
        collabCategory,
        updatedAt: asString(entry.updatedAt) || new Date().toISOString(),
        updatedBy: asString(entry.updatedBy),
      };
    }

    return result;
  } catch {
    return {};
  }
}

// ============================================================================

// ============================================================================
// MongoDB Persistence Layer (Design #2 Phase 2)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mongoDb: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mongoClient: any = null;

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGO_DB_NAME = "task_monitor";

async function connectMongo(): Promise<boolean> {
  if (!MONGODB_URI) {
    console.log("[MongoDB] No MONGODB_URI configured, skipping persistence layer");
    return false;
  }
  try {
    const { MongoClient } = await import("mongodb");
    mongoClient = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);

    // Create indexes
    const eventsCol = mongoDb.collection("coordination_events");
    await eventsCol.createIndex({ ts: -1 });
    await eventsCol.createIndex({ type: 1, ts: -1 });
    await eventsCol.createIndex({ agentId: 1, ts: -1 });
    await eventsCol.createIndex({ "data.conversationId": 1, ts: 1 });
    await eventsCol.createIndex({ "data.workSessionId": 1, ts: 1 });
    await eventsCol.createIndex({ eventRole: 1, ts: -1 });
    await eventsCol.createIndex({ collabCategory: 1, ts: -1 });
    await eventsCol.createIndex({ eventHash: 1 }, { unique: true });
    await eventsCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 }); // 90 days

    const sessionsCol = mongoDb.collection("work_sessions");
    await sessionsCol.createIndex({ status: 1, lastTime: -1 });
    await sessionsCol.createIndex({ collabCategory: 1, lastTime: -1 });
    await sessionsCol.createIndex({ "threads.conversationId": 1 });
    await sessionsCol.createIndex({ updatedAt: -1 });

    console.log("[MongoDB] Connected to", MONGODB_URI, "db:", MONGO_DB_NAME);
    return true;
  } catch (err) {
    console.error("[MongoDB] Connection failed:", (err as Error).message);
    mongoDb = null;
    mongoClient = null;
    return false;
  }
}

function computeEventHash(event: EnrichedCoordinationEvent): string {
  const type = event.type || "";
  const agentId = asString(event.agentId) || "";
  const ts = String(coordinationEventTimestampMs(event));
  const dataStr = JSON.stringify(event.data || {});
  // Simple hash — Bun supports crypto
  const raw = `${type}|${agentId}|${ts}|${dataStr}`;
  if (typeof Bun !== "undefined") {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(raw);
    return hasher.digest("hex");
  }
  // Fallback for non-Bun
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Sync new events from EventCache to MongoDB.
 * Called after each incremental file read.
 */
async function syncEventsToMongo(newEvents: EnrichedCoordinationEvent[]): Promise<void> {
  if (!mongoDb || newEvents.length === 0) {
    return;
  }

  const eventsCol = mongoDb.collection("coordination_events");
  const sessionsCol = mongoDb.collection("work_sessions");

  // 1. Upsert events (idempotent via eventHash)
  const eventDocs = newEvents.map((event) => {
    return {
      type: event.type,
      agentId: asString(event.agentId) || "unknown",
      ts: coordinationEventTimestampMs(event),
      createdAt: new Date(coordinationEventTimestampMs(event)),
      data: event.data,
      eventRole: event.eventRole,
      collabCategory: event.collabCategory,
      collabSubTags: event.collabSubTags,
      categoryConfidence: event.categoryConfidence,
      categorySource: event.categorySource,
      fromSessionType: event.fromSessionType,
      toSessionType: event.toSessionType,
      eventHash: computeEventHash(event),
    };
  });

  for (const doc of eventDocs) {
    try {
      await eventsCol.updateOne(
        { eventHash: doc.eventHash },
        { $setOnInsert: doc },
        { upsert: true },
      );
    } catch (err) {
      // Duplicate key is expected and safe to ignore
      if ((err as { code?: number }).code !== 11000) {
        console.error("[MongoDB] Event upsert error:", (err as Error).message);
      }
    }
  }

  // 2. Incrementally update work_sessions for affected workSessionIds
  const affectedWorkSessionIds = new Set<string>();
  for (const event of newEvents) {
    const wsId = asString(asRecord(event.data).workSessionId);
    if (wsId) {
      affectedWorkSessionIds.add(wsId);
    }
  }

  if (affectedWorkSessionIds.size > 0) {
    // Re-build work sessions from cache for affected IDs and upsert
    try {
      const allSessions = await eventCache.getWorkSessions();
      for (const wsId of affectedWorkSessionIds) {
        const session = allSessions.find((s) => s.workSessionId === wsId);
        if (!session) {
          continue;
        }

        await sessionsCol.updateOne(
          { _id: wsId as unknown as import("mongodb").ObjectId },
          {
            $set: {
              workSessionId: session.workSessionId,
              status: session.status,
              startTime: session.startTime,
              lastTime: session.lastTime,
              durationMs: session.durationMs,
              threadCount: session.threadCount,
              eventCount: session.eventCount,
              collabCategory: session.collabCategory,
              collabSubTags: session.collabSubTags,
              categorySource: session.categorySource,
              threads: session.threads.map((t) => ({
                id: t.id,
                conversationId: t.conversationId,
                fromAgent: t.fromAgent,
                toAgent: t.toAgent,
                startTime: t.startTime,
                lastTime: t.lastTime,
                eventCount: t.eventCount,
                collabCategory: t.collabCategory,
              })),
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
      }
    } catch (err) {
      console.error("[MongoDB] Work session sync error:", (err as Error).message);
    }
  }
}

/**
 * Full sync from EventCache to MongoDB (on startup).
 */
async function fullSyncToMongo(): Promise<void> {
  if (!mongoDb) {
    return;
  }

  const eventsCol = mongoDb.collection("coordination_events");
  const existingCount = await eventsCol.countDocuments();
  const cacheEvents = eventCache.getEvents();

  if (existingCount >= cacheEvents.length) {
    console.log(
      "[MongoDB] DB has",
      existingCount,
      "events, cache has",
      cacheEvents.length,
      "— skipping full sync",
    );
    return;
  }

  console.log("[MongoDB] Full sync:", cacheEvents.length, "events (DB has", existingCount, ")");

  // Batch upsert in chunks of 500
  const BATCH_SIZE = 500;
  let synced = 0;
  for (let i = 0; i < cacheEvents.length; i += BATCH_SIZE) {
    const batch = cacheEvents.slice(i, i + BATCH_SIZE);
    await syncEventsToMongo(batch);
    synced += batch.length;
  }
  console.log("[MongoDB] Full sync complete:", synced, "events processed");
}

// MongoDB search API handler
async function handleMongoSearch(url: URL, res: import("http").ServerResponse): Promise<boolean> {
  if (!mongoDb) {
    return false;
  }

  const searchQuery = url.searchParams.get("q");
  if (!searchQuery) {
    return false;
  }

  const limit = Number(url.searchParams.get("limit")) || 50;
  const offset = Number(url.searchParams.get("offset")) || 0;
  const roleFilter = asString(url.searchParams.get("role")) || undefined;
  const category = asString(url.searchParams.get("viewCategory")) || undefined;

  try {
    const eventsCol = mongoDb.collection("coordination_events");
    const query: Record<string, unknown> = {
      $or: [
        { "data.message": { $regex: searchQuery, $options: "i" } },
        { "data.replyPreview": { $regex: searchQuery, $options: "i" } },
        { "data.fromAgent": { $regex: searchQuery, $options: "i" } },
        { "data.toAgent": { $regex: searchQuery, $options: "i" } },
        { type: { $regex: searchQuery, $options: "i" } },
      ],
    };

    if (roleFilter) {
      query.eventRole = roleFilter;
    }
    if (category && category !== "all") {
      query.collabCategory = category;
    }

    const [events, total] = await Promise.all([
      eventsCol.find(query).toSorted({ ts: -1 }).skip(offset).limit(limit).toArray(),
      eventsCol.countDocuments(query),
    ]);

    jsonResponse(res, {
      events,
      count: events.length,
      total,
      offset,
      limit,
      query: searchQuery,
    });
    return true;
  } catch (err) {
    console.error("[MongoDB] Search error:", (err as Error).message);
    return false;
  }
}

// MongoDB work sessions search
async function handleMongoWorkSessionSearch(
  url: URL,
  res: import("http").ServerResponse,
): Promise<boolean> {
  if (!mongoDb) {
    return false;
  }

  const searchQuery = url.searchParams.get("q");
  if (!searchQuery) {
    return false;
  }

  const limit = Number(url.searchParams.get("limit")) || 50;

  try {
    const sessionsCol = mongoDb.collection("work_sessions");
    const query = {
      $or: [
        { "threads.fromAgent": { $regex: searchQuery, $options: "i" } },
        { "threads.toAgent": { $regex: searchQuery, $options: "i" } },
        { collabCategory: { $regex: searchQuery, $options: "i" } },
        { workSessionId: { $regex: searchQuery, $options: "i" } },
      ],
    };

    const sessions = await sessionsCol
      .find(query)
      .toSorted({ lastTime: -1 })
      .limit(limit)
      .toArray();

    jsonResponse(res, {
      sessions,
      count: sessions.length,
      query: searchQuery,
    });
    return true;
  } catch (err) {
    console.error("[MongoDB] Work session search error:", (err as Error).message);
    return false;
  }
}

// EventCache — In-memory incremental event cache (Design #2 Phase 1)
// ============================================================================

class EventCache {
  private events: EnrichedCoordinationEvent[] = [];
  private workSessionsCache: {
    sessions: WorkSessionSummary[];
    expiresAtMs: number;
  } | null = null;
  private lastFileOffset = 0;
  private pendingLineFragment = "";
  private eventLogPath: string;
  private overridesCache: WorkSessionCategoryOverrideMap = {};
  private overridesMtimeMs = 0;
  private static MAX_EVENTS = 100_000;

  constructor(eventLogPath: string) {
    this.eventLogPath = eventLogPath;
  }

  /** Full load on startup */
  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.eventLogPath, "utf-8");
      const { events, pendingLineFragment } = parseCoordinationEventsFromRaw(raw);
      this.events = events;
      this.pendingLineFragment = pendingLineFragment;
      const stat = await fs.stat(this.eventLogPath);
      this.lastFileOffset = stat.size;
      this.workSessionsCache = null;
      console.log(
        "[EventCache] Initialized with",
        events.length,
        "events, offset:",
        this.lastFileOffset,
      );
    } catch (err) {
      console.error("[EventCache] Init failed, starting empty:", (err as Error).message);
      this.events = [];
      this.lastFileOffset = 0;
      this.pendingLineFragment = "";
      this.workSessionsCache = null;
    }
  }

  /** Incremental read on file change — returns newly added events */
  async onFileChange(): Promise<EnrichedCoordinationEvent[]> {
    try {
      const stat = await fs.stat(this.eventLogPath);
      const currentSize = stat.size;

      if (currentSize < this.lastFileOffset) {
        console.log("[EventCache] File rotated/truncated, full reload");
        await this.initialize();
        return this.events;
      }

      if (currentSize === this.lastFileOffset) {
        return [];
      }

      const fd = await fs.open(this.eventLogPath, "r");
      try {
        const newSize = currentSize - this.lastFileOffset;
        const buffer = Buffer.alloc(newSize);
        await fd.read(buffer, 0, newSize, this.lastFileOffset);
        const newData = buffer.toString("utf-8");
        const parsed = parseCoordinationEventsFromRaw(this.pendingLineFragment + newData);
        const newEvents = parsed.events;
        // Keep the trailing partial NDJSON fragment so a split append can be completed
        // on the next chokidar event without advancing the parser into the middle of a line.
        this.pendingLineFragment = parsed.pendingLineFragment;

        if (newEvents.length > 0) {
          this.events.push(...newEvents);
          if (this.events.length > EventCache.MAX_EVENTS) {
            this.events = this.events.slice(-EventCache.MAX_EVENTS);
          }
          this.workSessionsCache = null;
        }

        this.lastFileOffset = currentSize;
        return newEvents;
      } finally {
        await fd.close();
      }
    } catch (err) {
      console.error("[EventCache] onFileChange error:", (err as Error).message);
      return [];
    }
  }

  getEvents(): EnrichedCoordinationEvent[] {
    return this.events;
  }

  async getWorkSessions(options: BuildWorkSessionsOptions = {}): Promise<WorkSessionSummary[]> {
    const overridesChanged = await this.refreshOverrides();
    if (overridesChanged) {
      this.workSessionsCache = null;
    }

    const hasFilters = options.roleFilters || options.eventTypeFilters;
    if (hasFilters) {
      return buildWorkSessionsFromEvents(this.events, {
        ...options,
        categoryOverrides: this.overridesCache,
      });
    }

    const nowMs = options.nowMs ?? Date.now();
    if (!this.workSessionsCache || nowMs >= this.workSessionsCache.expiresAtMs) {
      const sessions = buildWorkSessionsFromEvents(this.events, {
        ...options,
        categoryOverrides: this.overridesCache,
      });
      this.workSessionsCache = {
        sessions,
        expiresAtMs: nextWorkSessionCacheExpiryMs(sessions),
      };
    }
    return this.workSessionsCache.sessions;
  }

  invalidateWorkSessions(): void {
    this.workSessionsCache = null;
  }

  private async refreshOverrides(): Promise<boolean> {
    try {
      const stat = await fs.stat(WORK_SESSION_CATEGORY_OVERRIDES_PATH);
      if (stat.mtimeMs !== this.overridesMtimeMs) {
        this.overridesCache = await readWorkSessionCategoryOverrides();
        this.overridesMtimeMs = stat.mtimeMs;
        return true;
      }
    } catch {
      if (Object.keys(this.overridesCache).length > 0) {
        this.overridesCache = {};
        this.overridesMtimeMs = 0;
        return true;
      }
    }
    return false;
  }
}

const eventLogPathForCache = path.join(OPENCLAW_DIR, "logs", "coordination-events.ndjson");
const eventCache = new EventCache(eventLogPathForCache);

async function writeWorkSessionCategoryOverrides(
  overrides: WorkSessionCategoryOverrideMap,
): Promise<void> {
  await fs.mkdir(path.dirname(WORK_SESSION_CATEGORY_OVERRIDES_PATH), { recursive: true });
  await fs.writeFile(
    WORK_SESSION_CATEGORY_OVERRIDES_PATH,
    `${JSON.stringify(overrides, null, 2)}\n`,
    "utf-8",
  );
}

// ============================================================================
// HTTP Request Handlers
// ============================================================================

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Task-Monitor-Token, Cookie");
  res.end(JSON.stringify(data, null, 2));
}

function errorResponse(res: http.ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Task-Monitor-Token, Cookie");
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST" && req.method !== "PATCH") {
    errorResponse(res, "Method not allowed", 405);
    return;
  }

  // Routes
  if (pathname === "/api/health") {
    jsonResponse(res, { status: "ok", timestamp: new Date().toISOString() });
    return;
  }

  if (pathname === "/api/agents") {
    const agents = await listAgents();
    jsonResponse(res, { agents, count: agents.length });
    return;
  }

  // Agent-specific routes
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/(.+)$/);
  if (agentMatch) {
    const agentId = agentMatch[1];
    const action = agentMatch[2];

    const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
    const agentInfo = await getAgentInfo(agentId);
    if (!agentInfo) {
      errorResponse(res, `Agent not found: ${agentId}`, 404);
      return;
    }

    // Single task by ID: /api/agents/:agentId/tasks/:taskId
    const taskIdMatch = action.match(/^tasks\/(.+)$/);
    if (taskIdMatch) {
      const taskId = taskIdMatch[1];
      const task = await getTaskById(agentId, taskId);
      if (task) {
        jsonResponse(res, { agentId, task, source: task.source || "active" });
      } else {
        jsonResponse(res, { agentId, task: null, source: "not_found" });
      }
      return;
    }

    if (action === "tasks") {
      const status = url.searchParams.get("status") as TaskStatus | null;
      const tasks = await listTasks(agentId, status || undefined);
      jsonResponse(res, { agentId, tasks, count: tasks.length });
      return;
    }

    if (action === "current") {
      const current = await getCurrentTask(agentId);
      jsonResponse(res, current);
      return;
    }

    if (action === "history") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const month = url.searchParams.get("month") || undefined;
      const { entries, months } = await getTaskHistory(agentId, { limit, month });
      jsonResponse(res, {
        agentId,
        history: entries,
        months,
        currentMonth: month || months[0] || null,
        hasHistory: entries.length > 0,
      });
      return;
    }

    if (action === "info") {
      jsonResponse(res, agentInfo);
      return;
    }

    if (action === "blocked") {
      const tasks = await listTasks(agentId, "blocked");
      const blockedDetails = tasks.map((t) => ({
        id: t.id,
        description: t.description,
        blockedReason: t.blockedReason,
        unblockedBy: t.unblockedBy,
        unblockedAction: t.unblockedAction,
        unblockRequestCount: t.unblockRequestCount,
        escalationState: t.escalationState,
        lastUnblockerIndex: t.lastUnblockerIndex,
        lastUnblockRequestAt: t.lastUnblockRequestAt,
        unblockRequestFailures: t.unblockRequestFailures,
        lastActivity: t.lastActivity,
      }));
      jsonResponse(res, { agentId, blockedTasks: blockedDetails, count: blockedDetails.length });
      return;
    }

    if (action === "plans") {
      // Look in both workspace-level and global plans directories
      const workspacePlansDir = path.join(workspaceDir, ".openclaw", "plans");
      const globalPlansDir = path.join(OPENCLAW_DIR, "plans");
      const plans: Array<Record<string, unknown>> = [];

      // Read from workspace plans
      try {
        const files = await fs.readdir(workspacePlansDir);
        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }
          try {
            const raw = await fs.readFile(path.join(workspacePlansDir, file), "utf-8");
            const parsed = parseJsonSafe(raw);
            if (parsed && typeof parsed === "object") {
              plans.push(parsed as Record<string, unknown>);
            }
          } catch {
            /* skip invalid */
          }
        }
      } catch {
        /* no workspace plans dir */
      }

      // Read from global plans (filter by agentId)
      try {
        const files = await fs.readdir(globalPlansDir);
        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }
          try {
            const raw = await fs.readFile(path.join(globalPlansDir, file), "utf-8");
            const parsed = parseJsonSafe(raw);
            if (!parsed || typeof parsed !== "object") {
              continue;
            }
            const plan = parsed as Record<string, unknown>;
            const planAgentId = typeof plan.agentId === "string" ? plan.agentId : "";
            if (planAgentId === agentId || file.startsWith(agentId + "_")) {
              plans.push(plan);
            }
          } catch {
            /* skip invalid */
          }
        }
      } catch {
        /* no global plans dir */
      }

      // Sort by updatedAt/createdAt descending
      const resolvePlanTimestamp = (plan: Record<string, unknown>): number => {
        const candidate =
          (typeof plan.updatedAt === "string" && plan.updatedAt) ||
          (typeof plan.createdAt === "string" && plan.createdAt) ||
          (typeof plan.submittedAt === "string" && plan.submittedAt) ||
          0;
        return new Date(candidate).getTime();
      };
      plans.sort((a, b) => {
        const ta = resolvePlanTimestamp(a);
        const tb = resolvePlanTimestamp(b);
        return tb - ta;
      });
      jsonResponse(res, { agentId, plans, count: plans.length });
      return;
    }

    errorResponse(res, `Unknown action: ${action}`, 404);
    return;
  }

  // Team State endpoint
  if (pathname === "/api/team-state") {
    const teamStatePath = path.join(OPENCLAW_DIR, "team-state.json");
    try {
      const raw = await fs.readFile(teamStatePath, "utf-8");
      const state = normalizeTeamState(parseJsonSafe(raw));
      jsonResponse(res, state);
    } catch {
      jsonResponse(res, { version: 1, agents: {}, lastUpdatedMs: 0 });
    }
    return;
  }

  // Plans endpoint moved into agent action handler above

  // Events endpoint: /api/events?limit=100&since=<ISO>&role=<role>&viewCategory=<category>
  // MongoDB-backed search endpoint (Design #2 Phase 2)
  if (pathname === "/api/events/search") {
    const handled = await handleMongoSearch(url, res);
    if (!handled) {
      jsonResponse(res, { events: [], count: 0, total: 0, error: "MongoDB not available" });
    }
    return;
  }

  if (pathname === "/api/work-sessions/search") {
    const handled = await handleMongoWorkSessionSearch(url, res);
    if (!handled) {
      jsonResponse(res, { sessions: [], count: 0, error: "MongoDB not available" });
    }
    return;
  }

  if (pathname === "/api/events") {
    const limit = Number(url.searchParams.get("limit")) || 100;
    const since = url.searchParams.get("since");
    const roleFilter = asString(url.searchParams.get("role")) || undefined;
    const viewCategory = asString(url.searchParams.get("viewCategory")) || undefined;
    const typeFilters = parseCsvQueryParam(url, "type");
    const requestedTypes = normalizeEventTypeFilters(typeFilters);
    try {
      // REST reads opportunistically catch up from disk so a missed chokidar event does not
      // leave task-hub/task-monitor stuck on stale coordination data.
      await eventCache.onFileChange();
      const allEvents = eventCache.getEvents();
      let events = [...allEvents];

      if (since) {
        const sinceMs = new Date(since).getTime();
        events = events.filter((event) => coordinationEventTimestampMs(event) >= sinceMs);
      }

      if (roleFilter) {
        events = events.filter((event) => event.eventRole === roleFilter);
      }

      if (requestedTypes) {
        events = events.filter((event) => requestedTypes.has(event.type));
      }

      if (viewCategory && viewCategory !== "all") {
        events = events.filter((event) => event.collabCategory === viewCategory);
      }

      const categoryCounts: Record<string, number> = {};
      for (const event of events) {
        const key = event.collabCategory;
        categoryCounts[key] = (categoryCounts[key] || 0) + 1;
      }

      const totalMatched = events.length;
      const limitedEvents = events.slice(-Math.max(1, limit));

      jsonResponse(res, {
        events: limitedEvents,
        count: limitedEvents.length,
        total: allEvents.length,
        totalMatched,
        role: roleFilter || null,
        type: typeFilters,
        viewCategory: viewCategory || null,
        categoryCounts,
      });
    } catch {
      jsonResponse(res, {
        events: [],
        count: 0,
        total: 0,
        totalMatched: 0,
        role: roleFilter || null,
        type: typeFilters,
        viewCategory: viewCategory || null,
        categoryCounts: {},
      });
    }
    return;
  }

  const workSessionCategoryPatchMatch = pathname.match(/^\/api\/work-sessions\/([^/]+)\/category$/);
  if (workSessionCategoryPatchMatch) {
    if (req.method !== "PATCH") {
      errorResponse(res, "Method not allowed", 405);
      return;
    }

    if (!isAuthorizedWriteRequest(req)) {
      errorResponse(res, "Unauthorized", 401);
      return;
    }

    const workSessionId = decodeURIComponent(workSessionCategoryPatchMatch[1]);
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");
    let body: { collabCategory?: string; updatedBy?: string };
    try {
      body = JSON.parse(bodyStr);
    } catch {
      errorResponse(res, "Invalid JSON body", 400);
      return;
    }

    const collabCategory = asCollaborationCategory(body.collabCategory);
    if (!collabCategory) {
      errorResponse(res, "collabCategory is required and must be a valid category", 400);
      return;
    }

    const overrides = await readWorkSessionCategoryOverrides();
    overrides[workSessionId] = {
      collabCategory,
      updatedAt: new Date().toISOString(),
      updatedBy: asString(body.updatedBy),
    };
    await writeWorkSessionCategoryOverrides(overrides);
    eventCache.invalidateWorkSessions();

    jsonResponse(res, {
      ok: true,
      workSessionId,
      override: overrides[workSessionId],
    });
    return;
  }

  const workSessionDetailMatch = pathname.match(/^\/api\/work-sessions\/([^/]+)$/);
  if (workSessionDetailMatch) {
    if (req.method !== "GET") {
      errorResponse(res, "Method not allowed", 405);
      return;
    }

    const workSessionId = decodeURIComponent(workSessionDetailMatch[1]);
    const roleFilter = asString(url.searchParams.get("role")) || undefined;
    const role = roleFilter ? eventRoleFromValue(roleFilter) : null;
    const typeFilters = parseCsvQueryParam(url, "type");
    try {
      await eventCache.onFileChange();
      const sessions = await eventCache.getWorkSessions({
        roleFilters: role ? [role] : undefined,
        eventTypeFilters: typeFilters.length > 0 ? typeFilters : undefined,
      });
      const session = sessions.find((entry) => entry.workSessionId === workSessionId);
      if (!session) {
        errorResponse(res, `Work session not found: ${workSessionId}`, 404);
        return;
      }
      jsonResponse(res, { session, role: role ?? null, type: typeFilters });
    } catch {
      errorResponse(res, "Failed to read work session", 500);
    }
    return;
  }

  // Work session endpoint: /api/work-sessions?status=ACTIVE|QUIET|ARCHIVED&role=...&limit=...
  if (pathname === "/api/work-sessions") {
    if (req.method !== "GET") {
      errorResponse(res, "Method not allowed", 405);
      return;
    }

    const limit = Number(url.searchParams.get("limit")) || 100;
    const viewCategory = asString(url.searchParams.get("viewCategory")) || undefined;
    const subTag = asString(url.searchParams.get("subTag")) || undefined;
    const rawRoleFilters = parseCsvQueryParam(url, "role");
    const roleFilters = rawRoleFilters
      .map((value) => eventRoleFromValue(value))
      .filter((value): value is EventRole => !!value);
    const rawTypeFilters = parseCsvQueryParam(url, "type");
    const typeFilters = normalizeEventTypeFilters(rawTypeFilters);
    const rawStatusFilters = parseCsvQueryParam(url, "status");

    const statusFilters = rawStatusFilters.filter(
      (value): value is WorkSessionStatus =>
        value === "ACTIVE" || value === "QUIET" || value === "ARCHIVED",
    );
    const requestedStatuses = new Set(statusFilters);

    try {
      await eventCache.onFileChange();
      const sessions = await eventCache.getWorkSessions({
        roleFilters: roleFilters.length > 0 ? roleFilters : undefined,
        eventTypeFilters: typeFilters,
      });

      let filtered = sessions;
      if (requestedStatuses.size > 0) {
        filtered = filtered.filter((session) => requestedStatuses.has(session.status));
      }
      if (viewCategory && viewCategory !== "all") {
        filtered = filtered.filter((session) => session.collabCategory === viewCategory);
      }
      if (subTag) {
        const needle = subTag.toLowerCase();
        filtered = filtered.filter((session) =>
          session.collabSubTags.some((tag) => tag.toLowerCase() === needle),
        );
      }

      const categoryCounts: Record<string, number> = {};
      for (const session of filtered) {
        const key = session.collabCategory;
        categoryCounts[key] = (categoryCounts[key] || 0) + 1;
      }

      const limitedSessions = filtered.slice(0, Math.max(1, limit));
      jsonResponse(res, {
        sessions: limitedSessions,
        count: limitedSessions.length,
        totalMatched: filtered.length,
        totalSessions: sessions.length,
        role: roleFilters,
        type: rawTypeFilters,
        status: statusFilters,
        viewCategory: viewCategory || null,
        subTag: subTag || null,
        categoryCounts,
      });
    } catch {
      jsonResponse(res, {
        sessions: [],
        count: 0,
        totalMatched: 0,
        totalSessions: 0,
        role: roleFilters,
        type: rawTypeFilters,
        status: statusFilters,
        viewCategory: viewCategory || null,
        subTag: subTag || null,
        categoryCounts: {},
      });
    }
    return;
  }

  // Root endpoint
  if (pathname === "/" || pathname === "/api") {
    jsonResponse(res, {
      name: "Task Monitor API",
      version: "1.3.0",
      endpoints: [
        "GET /api/health",
        "GET /api/agents",
        "GET /api/agents/:agentId/info",
        "GET /api/agents/:agentId/tasks",
        "GET /api/agents/:agentId/tasks/:taskId",
        "GET /api/agents/:agentId/tasks?status=in_progress",
        "GET /api/agents/:agentId/current",
        "GET /api/agents/:agentId/blocked",
        "GET /api/agents/:agentId/history",
        "GET /api/agents/:agentId/history?month=2026-02",
        "GET /api/agents/:agentId/plans",
        "GET /api/team-state",
        "GET /api/events?limit=100&since=<ISO>&role=<conversation.main|delegation.subagent|orchestration.task|system.observability>&type=<a2a.response,...>&viewCategory=<category>",
        "GET /api/work-sessions?status=ACTIVE|QUIET|ARCHIVED&limit=100&role=<conversation.main|delegation.subagent|orchestration.task|system.observability>&type=<a2a.response,...>&viewCategory=<category>&subTag=<tag>",
        "GET /api/work-sessions/:id?role=<conversation.main|delegation.subagent|orchestration.task|system.observability>&type=<a2a.response,...>",
        "PATCH /api/work-sessions/:id/category",
        "POST /api/workspace-file",
        "WS /ws",
      ],
      docs: "https://github.com/pronto-lab/prontolab-openclaw/blob/main/PRONTOLAB.md",
    });
    return;
  }

  // POST /api/workspace-file — Write a file to a workspace directory
  if (pathname === "/api/workspace-file" && req.method === "POST") {
    if (!isAuthorizedWriteRequest(req)) {
      errorResponse(res, "Unauthorized", 401);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");
    let body: { path?: string; content?: string };
    try {
      body = JSON.parse(bodyStr);
    } catch {
      errorResponse(res, "Invalid JSON body", 400);
      return;
    }
    if (!body.path || typeof body.content !== "string") {
      errorResponse(res, "path and content are required", 400);
      return;
    }

    const normalizedInputPath = body.path.replace(/\\/g, "/").trim();
    const targetPath = path.resolve(OPENCLAW_DIR, normalizedInputPath);
    const relativePath = path.relative(OPENCLAW_DIR, targetPath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      errorResponse(res, "Path traversal not allowed", 403);
      return;
    }

    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, body.content, "utf-8");
      console.log(`[workspace-file] Wrote ${relativePath} (${body.content.length} bytes)`);
      jsonResponse(res, { ok: true, path: relativePath, bytes: body.content.length });
    } catch (err) {
      console.error(`[workspace-file] Write failed:`, err);
      errorResponse(res, "Failed to write file", 500);
    }
    return;
  }

  // GET /api/milestones — Proxy to Task Hub
  if (pathname === "/api/milestones" || pathname.startsWith("/api/milestones/")) {
    try {
      const targetUrl = `${TASK_HUB_URL}${pathname}${url.search}`;
      const cookieHeader = buildTaskHubCookieHeader(req);
      const headers: Record<string, string> = {};
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
      const resp = await fetch(targetUrl, {
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      const body = await resp.text();
      jsonResponse(res, parseJsonSafe(body), resp.status);
    } catch {
      errorResponse(res, "Failed to proxy milestone request", 502);
    }
    return;
  }

  errorResponse(res, "Not found", 404);
}

// ============================================================================
// WebSocket & File Watching
// ============================================================================

function setupWebSocket(server: http.Server): {
  wss: WebSocketServer;
  watcherReady: Promise<void>;
} {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[ws] Client connected (${clients.size} total)`);

    // Send welcome message
    const welcome: WsMessage = {
      type: "connected",
      timestamp: new Date().toISOString(),
      data: { message: "Connected to Task Monitor" },
    };
    ws.send(JSON.stringify(welcome));

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected (${clients.size} remaining)`);
    });

    ws.on("error", (err) => {
      console.error("[ws] Client error:", err.message);
      clients.delete(ws);
    });
  });

  // Broadcast to all clients
  function broadcast(message: WsMessage): void {
    const json = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(json);
        } catch {
          clients.delete(client);
        }
      }
    }
  }

  // Setup file watcher
  // NOTE: chokidar glob patterns (workspace-*/tasks/*.md) don't expand correctly
  // in Bun. Use explicit directory paths instead.
  const entriesSync = fsSync.readdirSync(OPENCLAW_DIR, { withFileTypes: true });
  const workspaceDirs = entriesSync
    .filter((e) => e.isDirectory() && e.name.startsWith(WORKSPACE_PREFIX))
    .map((e) => e.name);

  const watchPaths: string[] = [
    // Global files
    path.join(OPENCLAW_DIR, "team-state.json"),
    path.join(OPENCLAW_DIR, "logs", "coordination-events.ndjson"),
    path.join(OPENCLAW_DIR, "plans"),
  ];

  // Add per-workspace task directories and CURRENT_TASK files
  for (const dir of workspaceDirs) {
    watchPaths.push(path.join(OPENCLAW_DIR, dir, TASKS_DIR));
    watchPaths.push(path.join(OPENCLAW_DIR, dir, CURRENT_TASK_FILENAME));
    watchPaths.push(path.join(OPENCLAW_DIR, dir, "MILESTONES.md"));
    watchPaths.push(path.join(OPENCLAW_DIR, dir, ".openclaw", "plans"));
  }

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: [
      // Lock files cause rapid add/unlink storms (15 agents x heartbeat cycle)
      // that saturate the event loop and hang the HTTP server.
      /continuation_[^/]+\.lock$/,
      /\.lock$/,
      // OS junk
      /(^|[/\\])\../, // dotfiles
      /node_modules/,
    ],
  });
  const watcherReady = new Promise<void>((resolve) => {
    watcher.once("ready", () => {
      // Delay serving until chokidar finishes its initial scan; otherwise appends that happen
      // immediately after startup can be missed before the watcher enters steady state.
      console.log("[watch] Watching for task changes...");
      resolve();
    });
  });

  watcher.on("all", (event, filePath) => {
    const relativePath = path.relative(OPENCLAW_DIR, filePath);
    const basename = path.basename(filePath);

    // Skip lock files — defense in depth (also excluded via chokidar ignored)
    if (basename.endsWith(".lock")) {
      return;
    }

    // Handle global (non-workspace) files first
    const isTeamState = basename === "team-state.json";
    const isEventLog = basename === "coordination-events.ndjson";
    const isGlobalPlan = relativePath.startsWith("plans/") && basename.endsWith(".json");

    if (isTeamState || isEventLog || isGlobalPlan) {
      let msgType: WsMessage["type"] = "team_state_update";
      if (isEventLog) {
        msgType = "event_log";
      } else if (isGlobalPlan) {
        msgType = "plan_update";
      }

      const message: WsMessage = {
        type: msgType,
        agentId: isGlobalPlan ? basename.split("_")[0] : undefined,
        timestamp: new Date().toISOString(),
        data: { event, file: basename },
      };

      console.log(`[watch] ${event}: (global)/${basename}`);
      broadcast(message);
      if (isEventLog) {
        void (async () => {
          // Incremental cache update (Design #2 Phase 1)
          const newEvents = await eventCache.onFileChange();

          // Phase 2: Sync new events to MongoDB
          if (newEvents.length > 0) {
            syncEventsToMongo(newEvents).catch((err) =>
              console.error("[MongoDB] Sync error:", (err as Error).message),
            );
          }

          // Push actual event data via WebSocket
          if (newEvents.length > 0) {
            const affectedWorkSessionIds = new Set<string>();
            for (const ev of newEvents) {
              const wsId = asString(asRecord(ev.data).workSessionId);
              if (wsId) {
                affectedWorkSessionIds.add(wsId);
              }
            }

            broadcast({
              type: "coordination_event_new",
              timestamp: new Date().toISOString(),
              data: {
                events: newEvents,
                affectedWorkSessions: Array.from(affectedWorkSessionIds),
              },
            });
          }

          // Check for continuation events
          const lastNewEvent = newEvents[newEvents.length - 1];
          if (lastNewEvent) {
            const eventType = typeof lastNewEvent.type === "string" ? lastNewEvent.type : "";
            if (eventType.startsWith("continuation.")) {
              broadcast({
                type: "continuation_event",
                agentId: lastNewEvent.agentId as string | undefined,
                timestamp: new Date().toISOString(),
                data: {
                  event,
                  file: basename,
                  eventType,
                  eventData: lastNewEvent,
                },
              });
            }
          }
        })();
      }
      return;
    }

    // Extract agent ID from workspace path (format: workspace-{agentId}/...)
    const parts = relativePath.split(path.sep);
    const workspaceDir = parts[0];

    if (!workspaceDir || !workspaceDir.startsWith(WORKSPACE_PREFIX)) {
      return;
    }

    const agentId = workspaceDir.slice(WORKSPACE_PREFIX.length);

    // Determine update type for workspace files
    const isCurrentTask = filePath.includes(CURRENT_TASK_FILENAME);
    const isPlan = filePath.includes("/plans/") && filePath.endsWith(".json");
    const taskMatch = filePath.match(/task_([a-z0-9_]+)\.md$/);

    let msgType: WsMessage["type"] = "task_update";
    if (isCurrentTask) {
      msgType = "agent_update";
    } else if (isPlan) {
      msgType = "plan_update";
    }

    const message: WsMessage = {
      type: msgType,
      agentId,
      taskId: taskMatch ? `task_${taskMatch[1]}` : undefined,
      timestamp: new Date().toISOString(),
      data: { event, file: basename },
    };

    console.log(`[watch] ${event}: ${agentId}/${basename}`);
    broadcast(message);

    if (taskMatch) {
      void (async () => {
        try {
          const content = await fs.readFile(filePath, "utf-8");
          const parsedTask = parseTaskFileMd(content, basename);
          if (!parsedTask?.stepsProgress) {
            return;
          }
          broadcast({
            type: "task_step_update",
            agentId,
            taskId: parsedTask.id,
            timestamp: new Date().toISOString(),
            data: {
              event,
              file: basename,
              stepsProgress: parsedTask.stepsProgress,
              stepCount: parsedTask.steps?.length ?? 0,
            },
          });
        } catch {
          // best effort only
        }
      })();
    }
  });

  watcher.on("error", (err) => {
    console.error("[watch] Error:", err.message);
  });

  startMilestonePolling(broadcast);

  return { wss, watcherReady };
}

function startMilestonePolling(broadcast: (msg: WsMessage) => void): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const cookieHeader = buildTaskHubCookieHeader();
      const headers: Record<string, string> = {};
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
      const resp = await fetch(`${TASK_HUB_URL}/api/milestones`, {
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      if (!resp.ok) {
        return;
      }
      const body = await resp.text();
      const hash = simpleHash(body);
      if (hash !== lastMilestoneHash && lastMilestoneHash !== "") {
        broadcast({
          type: "task_update" as WsMessage["type"],
          timestamp: new Date().toISOString(),
          data: { event: "milestone_update", milestones: parseJsonSafe(body) },
        });
      }
      lastMilestoneHash = hash;
    } catch {
      /* hub unreachable, skip */
    }
  }, MILESTONE_POLL_INTERVAL_MS);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { port, host } = parseArgs();

  // Create HTTP server
  const server = http.createServer((req, res) => {
    // Skip WebSocket upgrade requests
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    handleRequest(req, res).catch((err) => {
      console.error("[http] Request error:", err);
      errorResponse(res, "Internal server error", 500);
    });
  });

  // Initialize event cache (Design #2 Phase 1)
  await eventCache.initialize();

  // Initialize MongoDB persistence (Design #2 Phase 2)
  const mongoConnected = await connectMongo();
  if (mongoConnected) {
    await fullSyncToMongo();
  }

  // Setup WebSocket
  const { watcherReady } = setupWebSocket(server);
  await watcherReady;

  // Start server
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    server.listen(port, host);
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🦞 Task Monitor API Server                         ║
╚══════════════════════════════════════════════════════════════╝

  HTTP:  http://${host}:${boundPort}
  WS:    ws://${host}:${boundPort}/ws

  Endpoints:
    GET /api/agents              - List all agents
    GET /api/agents/:id/tasks    - Get agent tasks
    GET /api/agents/:id/current  - Get current task
    GET /api/agents/:id/blocked  - Get blocked tasks
    GET /api/agents/:id/history  - Get task history

  Press Ctrl+C to stop
`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[shutdown] Stopping server...");
    if (mongoClient) {
      try {
        await mongoClient.close();
        console.log("[shutdown] MongoDB connection closed");
      } catch {
        /* ignore */
      }
    }
    server.close(() => {
      console.log("[shutdown] Server stopped");
      process.exit(0);
    });
  });
}

if (String(process.argv[1] || "").includes("task-monitor-server")) {
  main().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
