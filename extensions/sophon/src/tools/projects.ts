import { Type } from "@sinclair/typebox";
import { jsonResult, optionalStringEnum, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getSupabase } from "../lib/supabase.js";

const PRIORITY_VALUES = ["p1", "p2", "p3", "p4", "p5"] as const;

export function registerProjectTools(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "sophon_list_projects",
    label: "Sophon: List Projects",
    description: "List projects from Sophon with optional filters",
    parameters: Type.Object({
      category: Type.Optional(Type.String()),
      priority: optionalStringEnum(PRIORITY_VALUES),
      include_completed: Type.Optional(Type.Boolean({ default: false })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      let query = supabase
        .from("projects")
        .select(
          "id, name, description, category, priority_level, due_date, desired_outcome, completed_at, created_at, updated_at",
        );

      query = query.is("archived_at", null);

      if (!params.include_completed) {
        query = query.is("completed_at", null);
      }
      if (params.category) {
        query = query.eq("category", params.category);
      }
      if (params.priority) {
        query = query.eq("priority_level", params.priority);
      }

      const { data, error } = await query
        .order("priority_level", { ascending: true })
        .order("updated_at", { ascending: false })
        .limit(params.limit ?? 25);

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_get_project",
    label: "Sophon: Get Project",
    description: "Get one project by id with task status stats",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();

      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("*")
        .eq("id", params.id)
        .single();

      if (projectError) throw new Error(`Sophon API error: ${projectError.message}`);

      const { data: tasks, error: tasksError } = await supabase
        .from("tasks")
        .select("status_label")
        .eq("project_id", params.id)
        .is("archived_at", null);

      if (tasksError) throw new Error(`Sophon API error: ${tasksError.message}`);

      const taskStats: Record<string, number> = {};
      for (const task of tasks) {
        taskStats[task.status_label] = (taskStats[task.status_label] ?? 0) + 1;
      }

      return jsonResult({ ...project, task_stats: taskStats });
    },
  });

  api.registerTool({
    name: "sophon_create_project",
    label: "Sophon: Create Project",
    description: "Create a project in Sophon",
    parameters: Type.Object({
      name: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      priority_level: optionalStringEnum(PRIORITY_VALUES),
      due_date: Type.Optional(Type.String({ format: "date-time" })),
      desired_outcome: Type.Optional(Type.String()),
      team_id: Type.Optional(Type.String({ format: "uuid" })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("projects")
        .insert({
          name: params.name,
          description: params.description,
          category: params.category ?? "Uncategorized",
          priority_level: params.priority_level ?? "p2",
          due_date: params.due_date,
          desired_outcome: params.desired_outcome,
          team_id: params.team_id,
        })
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_update_project",
    label: "Sophon: Update Project",
    description: "Update fields on a project",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      name: Type.Optional(Type.String({ minLength: 1 })),
      description: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      priority_level: optionalStringEnum(PRIORITY_VALUES),
      due_date: Type.Optional(Type.String({ format: "date-time" })),
      desired_outcome: Type.Optional(Type.String()),
      visible_to_managers: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { id, ...fields } = params;

      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          updates[key] = value;
        }
      }

      const { data, error } = await supabase
        .from("projects")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_archive_project",
    label: "Sophon: Archive Project",
    description: "Archive (soft-delete) a project",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("projects")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", params.id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult({ project: data, reason: params.reason ?? null });
    },
  });
}
