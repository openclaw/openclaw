/** Task and worker type definitions. */

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "doing" | "done" | "failed";
  metadata?: {
    source?: string;
    target_node?: string;
    working_dir?: string;
    priority?: string;
    claimed_by?: string;
    claimed_at?: string;
  };
}

export interface TaskBackend {
  fetchPendingTasks(nodeName: string): Promise<Task[]>;
  updateTaskStatus(
    taskId: string,
    status: Task["status"],
    metadata?: Record<string, string>,
  ): Promise<void>;
}

export interface WorkerConfig {
  nodeName: string;
  maxThreads: number;
  pollIntervalMs: number;
  worktreeBaseDir: string;
  repoDir: string;
  archonUrl: string;
  archonProjectId: string;
}

export interface PlanStep {
  type: "ssh" | "claude_code" | "codex" | "auto";
  description: string;
  command?: string;
  prompt?: string;
}
