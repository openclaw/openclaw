import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi, stringEnum } from "openclaw/plugin-sdk";
import { getSupabase } from "../lib/supabase.js";

const ENTITY_TYPES = ["tasks", "projects", "notes"] as const;

type StatusBuckets = {
  backlog: number;
  in_progress: number;
  completed: number;
  blocked: number;
  waiting: number;
};

const EMPTY_STATUS_BUCKETS: StatusBuckets = {
  backlog: 0,
  in_progress: 0,
  completed: 0,
  blocked: 0,
  waiting: 0,
};

export function registerDashboardTools(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "sophon_dashboard",
    label: "Sophon: Dashboard",
    description: "Get task/project summary plus upcoming deadlines",
    parameters: Type.Object({
      team_id: Type.Optional(Type.String({ format: "uuid" })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const today = new Date().toISOString().slice(0, 10);

      let taskQuery = supabase.from("tasks").select("*").is("archived_at", null);
      let projectQuery = supabase.from("projects").select("*").is("archived_at", null);
      let upcomingQuery = supabase
        .from("tasks")
        .select("id, title, due_date, priority_level, project_id")
        .is("archived_at", null)
        .not("due_date", "is", null)
        .neq("status_label", "completed")
        .order("due_date", { ascending: true })
        .limit(5);

      if (params.team_id) {
        taskQuery = taskQuery.eq("team_id", params.team_id);
        projectQuery = projectQuery.eq("team_id", params.team_id);
        upcomingQuery = upcomingQuery.eq("team_id", params.team_id);
      }

      const [tasksResult, projectsResult, upcomingResult] = await Promise.all([
        taskQuery,
        projectQuery,
        upcomingQuery,
      ]);

      if (tasksResult.error) throw new Error(`Sophon API error: ${tasksResult.error.message}`);
      if (projectsResult.error) {
        throw new Error(`Sophon API error: ${projectsResult.error.message}`);
      }
      if (upcomingResult.error) {
        throw new Error(`Sophon API error: ${upcomingResult.error.message}`);
      }

      const statusCounts: StatusBuckets = { ...EMPTY_STATUS_BUCKETS };
      let overdue = 0;

      for (const task of tasksResult.data) {
        const status = task.status_label as keyof StatusBuckets;
        if (status in statusCounts) {
          statusCounts[status] += 1;
        }

        if (task.due_date && task.due_date < today && task.status_label !== "completed") {
          overdue += 1;
        }
      }

      const projects = projectsResult.data;
      const activeProjects = projects.filter((project) => project.completed_at === null).length;
      const completedProjects = projects.filter((project) => project.completed_at !== null).length;

      return jsonResult({
        tasks: {
          ...statusCounts,
          overdue,
          total: tasksResult.data.length,
        },
        projects: {
          active: activeProjects,
          completed: completedProjects,
          total: projects.length,
        },
        upcoming_deadlines: upcomingResult.data,
      });
    },
  });

  api.registerTool({
    name: "sophon_search",
    label: "Sophon: Search",
    description: "Search across Sophon tasks, projects, and notes",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      entity_types: Type.Optional(Type.Array(stringEnum(ENTITY_TYPES))),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const types = params.entity_types ?? ENTITY_TYPES;
      const limit = params.limit ?? 10;
      const pattern = `%${params.query}%`;

      const queryPromises: Record<
        string,
        PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
      > = {};

      if (types.includes("tasks")) {
        queryPromises.tasks = supabase
          .from("tasks")
          .select("id, title, status_label, priority_level, project_id, updated_at")
          .is("archived_at", null)
          .ilike("title", pattern)
          .limit(limit);
      }

      if (types.includes("projects")) {
        queryPromises.projects = supabase
          .from("projects")
          .select("id, name, category, priority_level, updated_at")
          .is("archived_at", null)
          .ilike("name", pattern)
          .limit(limit);
      }

      if (types.includes("notes")) {
        queryPromises.notes = supabase
          .from("notes")
          .select("id, title, task_id, project_id, updated_at")
          .is("archived_at", null)
          .ilike("title", pattern)
          .limit(limit);
      }

      const keys = Object.keys(queryPromises);
      const resolved = await Promise.all(Object.values(queryPromises));

      const output: Record<string, unknown[]> = {};
      for (const [index, key] of keys.entries()) {
        const row = resolved[index];
        if (row.error) {
          throw new Error(`Sophon API error: ${row.error.message}`);
        }
        output[key] = row.data ?? [];
      }

      return jsonResult(output);
    },
  });
}
