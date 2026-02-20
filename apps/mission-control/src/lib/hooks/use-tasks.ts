"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { getStoredModelPreference } from "@/components/views/settings/settings-types";
import { pushUndo } from "@/lib/undo-manager";
import { filterTasks, DEFAULT_FILTERS, type TaskFilters } from "@/components/task-filter-bar";
import { DEFAULT_WORKSPACE } from "@/lib/workspaces";
import { apiFetch } from "@/lib/api-fetch";

// --- Types ---

export interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  mission_id: string | null;
  assigned_agent_id: string | null;
  employee_id: string | null;
  openclaw_session_key: string | null;
  tags: string;
  due_date: string | null;
  cost_estimate: number | null;
  workspace_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name?: string;
  model?: string;
}

export interface GatewayStatus {
  connected: boolean;
  agentCount: number;
  cronJobCount: number;
}

export interface ActivityEntry {
  id: string;
  type: string;
  agent_id: string | null;
  task_id: string | null;
  message: string;
  metadata: string;
  created_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  agent_id: string | null;
  author_type: string;
  content: string;
  created_at: string;
}

// --- Toast Hook ---

export function useToast() {
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const clearToast = useCallback(() => setToast(null), []);

  return { toast, showToast, clearToast };
}

// --- Tasks Hook ---

export function useTasks(workspaceId: string = DEFAULT_WORKSPACE) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>({
    connected: false,
    agentCount: 0,
    cronJobCount: 0,
  });
  const gatewayStatusFailures = useRef(0);
  const { toast, showToast, clearToast } = useToast();

  // --- Task Filtering ---
  const [taskFilters, setTaskFilters] = useState<TaskFilters>(DEFAULT_FILTERS);

  // Apply filters to tasks
  const filteredTasks = useMemo(() => {
    return filterTasks(tasks, taskFilters);
  }, [tasks, taskFilters]);

  // Check if any filters are active
  const hasActiveFilters = useMemo(() => {
    return taskFilters.search !== "" ||
      taskFilters.priority !== null ||
      taskFilters.assignee !== null ||
      taskFilters.status !== null;
  }, [taskFilters]);

  // --- Data Fetching ---

  const fetchTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams({ workspace_id: workspaceId });
      const res = await apiFetch(`/api/tasks?${params.toString()}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch { /* retry */ }
  }, [workspaceId]);

  const fetchActivity = useCallback(async () => {
    try {
      const params = new URLSearchParams({ workspace_id: workspaceId });
      const res = await apiFetch(`/api/activity?${params.toString()}`);
      const data = await res.json();
      setActivity(data.activity || []);
    } catch { /* retry */ }
  }, [workspaceId]);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await apiFetch("/api/agents");
      const data = await res.json();
      setAgents(data.agents || []);
    } catch { /* retry */ }
  }, []);

  const fetchGatewayStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/openclaw/status");
      if (!res.ok) {
        throw new Error(`status endpoint returned ${res.status}`);
      }
      const data = await res.json();
      if (typeof data.connected !== "boolean") {
        throw new Error("Invalid gateway status payload");
      }
      gatewayStatusFailures.current = 0;
      setGatewayStatus({
        connected: data.connected,
        agentCount: Number(data.agentCount ?? 0),
        cronJobCount: Number(data.cronJobCount ?? 0),
      });
    } catch {
      gatewayStatusFailures.current += 1;
      if (gatewayStatusFailures.current >= 3) {
        setGatewayStatus({ connected: false, agentCount: 0, cronJobCount: 0 });
      }
    }
  }, []);

  // --- Task Actions ---

  const createTask = useCallback(async (data: {
    title: string;
    description: string;
    priority: string;
    assigned_agent_id?: string;
    employee_id?: string | null;
    due_date?: string | null;
    cost_estimate?: number | null;
    tags?: string[];
  }) => {
    try {
      const res = await apiFetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          workspace_id: workspaceId,
        }),
      });
      const result = await res.json();

      if (!res.ok) {
        showToast(result.error || "Failed to create task", "error");
        return false;
      }

      // Auto-dispatch if agent is assigned
      if (data.assigned_agent_id && result.task?.id) {
        const pref = getStoredModelPreference();
        const dispatchRes = await apiFetch("/api/tasks/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: result.task.id,
            agentId: data.assigned_agent_id,
            ...(pref ? { model: pref.model, provider: pref.provider } : {}),
          }),
        });
        if (!dispatchRes.ok) {
          showToast("Task created but dispatch failed", "error");
        }
      }

      await fetchTasks();
      await fetchActivity();
      showToast("Task created successfully", "success");
      return true;
    } catch {
      showToast("Failed to create task", "error");
      return false;
    }
  }, [fetchTasks, fetchActivity, showToast, workspaceId]);

  const moveTask = useCallback(async (taskId: string, newStatus: string) => {
    try {
      const existing = tasks.find((task) => task.id === taskId);
      if (existing && existing.status === newStatus) {
        return true;
      }
      const res = await apiFetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId, status: newStatus, workspace_id: workspaceId }),
      });
      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || "Failed to move task", "error");
        return false;
      }
      await fetchTasks();
      await fetchActivity();
      return true;
    } catch {
      showToast("Failed to move task", "error");
      return false;
    }
  }, [tasks, fetchTasks, fetchActivity, showToast, workspaceId]);

  const deleteTask = useCallback(async (taskId: string, skipUndo = false) => {
    // Find the task before deleting (for undo)
    const taskToDelete = tasks.find(t => t.id === taskId);

    try {
      const res = await apiFetch(`/api/tasks?id=${taskId}&workspace_id=${workspaceId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || "Failed to delete task", "error");
        return false;
      }
      await fetchTasks();
      await fetchActivity();

      // Push undo action if we have the task data and not skipping undo
      if (taskToDelete && !skipUndo) {
        pushUndo({
          type: "task_delete",
          description: `Deleted "${taskToDelete.title}"`,
          data: taskToDelete,
          undo: async () => {
            // Restore the task
            await apiFetch("/api/tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                title: taskToDelete.title,
                description: taskToDelete.description,
                status: taskToDelete.status,
                priority: taskToDelete.priority,
                mission_id: taskToDelete.mission_id,
                assigned_agent_id: taskToDelete.assigned_agent_id,
                employee_id: taskToDelete.employee_id ?? null,
                workspace_id: taskToDelete.workspace_id || workspaceId,
                due_date: taskToDelete.due_date,
                cost_estimate: taskToDelete.cost_estimate,
                tags: (() => {
                  try {
                    return taskToDelete.tags ? JSON.parse(taskToDelete.tags) : [];
                  } catch {
                    return [];
                  }
                })(),
              }),
            });
            await fetchTasks();
            await fetchActivity();
          },
        });
        // Don't show toast - undo toast handles UX
      } else {
        showToast("Task deleted", "success");
      }
      return true;
    } catch {
      showToast("Failed to delete task", "error");
      return false;
    }
  }, [tasks, fetchTasks, fetchActivity, showToast, workspaceId]);

  const dispatchTask = useCallback(async (taskId: string, agentId: string) => {
    try {
      const pref = getStoredModelPreference();
      const res = await apiFetch("/api/tasks/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          agentId,
          ...(pref ? { model: pref.model, provider: pref.provider } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        showToast(data.error || "Failed to dispatch task", "error");
        return data;
      }

      await fetchTasks();
      await fetchActivity();
      showToast("Task dispatched to agent", "success");
      return data;
    } catch {
      showToast("Failed to dispatch task", "error");
      return { error: "Network error" };
    }
  }, [fetchTasks, fetchActivity, showToast]);

  // Use filtered tasks for column display
  const getColumnTasks = useCallback((status: string) => {
    return filteredTasks.filter((t) => t.status === status);
  }, [filteredTasks]);

  // Clear all filters
  const clearFilters = useCallback(() => {
    setTaskFilters(DEFAULT_FILTERS);
  }, []);

  return {
    // State
    tasks,
    filteredTasks,
    activity,
    agents,
    gatewayStatus,
    toast,
    // Filter state
    taskFilters,
    setTaskFilters,
    hasActiveFilters,
    clearFilters,
    // Fetch functions
    fetchTasks,
    fetchActivity,
    fetchAgents,
    fetchGatewayStatus,
    // Actions
    createTask,
    moveTask,
    deleteTask,
    dispatchTask,
    getColumnTasks,
    // Toast
    showToast,
    clearToast,
  };
}
