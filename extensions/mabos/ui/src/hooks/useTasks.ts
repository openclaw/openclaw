import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Task } from "@/lib/types";

function mapStatus(s: string): Task["status"] {
  const map: Record<string, Task["status"]> = {
    proposed: "backlog",
    pending: "todo",
    active: "in_progress",
    in_progress: "in_progress",
    review: "review",
    completed: "done",
    done: "done",
  };
  return map[s?.toLowerCase()] || "backlog";
}

function normalizeTask(raw: any): Task {
  return {
    id: raw.id || raw.step_id || "",
    plan_id: raw.plan_id || "default",
    plan_name: raw.plan_name || "General",
    step_id: raw.step_id || "",
    title: raw.title || raw.description || "",
    description: raw.description,
    status: mapStatus(raw.status),
    priority: raw.priority || "medium",
    type: raw.type || "primitive",
    assignedAgents: raw.assignedAgents || (raw.assigned_to ? [raw.assigned_to] : []),
    department: raw.department || "",
    depends_on: raw.depends_on || [],
    estimated_duration: raw.estimated_duration || "",
    agent_id: raw.agent_id || "",
  };
}

export function useTasks(businessId: string) {
  return useQuery<Task[]>({
    queryKey: ["tasks", businessId],
    queryFn: async () => {
      const raw = await api.getTasks(businessId);
      return (raw.tasks ?? []).map(normalizeTask);
    },
    enabled: !!businessId,
  });
}
