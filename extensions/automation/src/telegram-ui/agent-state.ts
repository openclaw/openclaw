export type AgentPhase =
  | "idle"
  | "thinking"
  | "coding"
  | "testing"
  | "reviewing"
  | "deploying"
  | "awaiting_input"
  | "error";

export type ActiveTask = {
  id: string;
  title: string;
  phase: AgentPhase;
  agent: "claude" | "codex";
  startedAt: number;
  stepCurrent: number;
  stepTotal: number;
  currentAction: string;
  thinkingLine?: string;
};

export type AttentionItem = {
  id: string;
  kind: "approval" | "error" | "ci_fail" | "pr_ready" | "stale_pr" | "task_done";
  title: string;
  urgency: "loud" | "quiet" | "silent";
  createdAt: number;
  actionCallbacks: Array<{ label: string; data: string }>;
};

export type SystemState = {
  phase: AgentPhase;
  activeTask: ActiveTask | null;
  queuedTasks: number;
  attentionItems: AttentionItem[];
  lastCompletedTask: { title: string; success: boolean; completedAt: number } | null;
  agents: {
    claude: { status: "online" | "busy" | "offline"; model: string };
    codex: { status: "online" | "busy" | "offline"; model: string };
  };
  stats: {
    tokensToday: number;
    tasksToday: number;
    uptime: number;
  };
};

let currentState: SystemState = {
  phase: "idle",
  activeTask: null,
  queuedTasks: 0,
  attentionItems: [],
  lastCompletedTask: null,
  agents: {
    claude: { status: "online", model: "claude-sonnet-4-6" },
    codex: { status: "online", model: "codex-mini" },
  },
  stats: { tokensToday: 0, tasksToday: 0, uptime: 0 },
};

export function getSystemState(): SystemState {
  return currentState;
}

export function updateSystemState(patch: Partial<SystemState>) {
  currentState = { ...currentState, ...patch };
}

export function setActiveTask(task: ActiveTask | null) {
  currentState.activeTask = task;
  currentState.phase = task?.phase ?? "idle";
}

export function updateTaskProgress(stepCurrent: number, currentAction: string, thinkingLine?: string) {
  if (currentState.activeTask) {
    currentState.activeTask.stepCurrent = stepCurrent;
    currentState.activeTask.currentAction = currentAction;
    currentState.activeTask.thinkingLine = thinkingLine;
  }
}

export function completeTask(success: boolean) {
  if (currentState.activeTask) {
    currentState.lastCompletedTask = {
      title: currentState.activeTask.title,
      success,
      completedAt: Date.now(),
    };
    currentState.stats.tasksToday++;
    currentState.activeTask = null;
    currentState.phase = "idle";
  }
}

export function addAttentionItem(item: AttentionItem) {
  currentState.attentionItems = [item, ...currentState.attentionItems].slice(0, 20);
}

export function dismissAttentionItem(id: string) {
  currentState.attentionItems = currentState.attentionItems.filter((i) => i.id !== id);
}

export function getUrgentItems(): AttentionItem[] {
  return currentState.attentionItems.filter((i) => i.urgency === "loud");
}
