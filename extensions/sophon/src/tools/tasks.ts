import { Type } from "@sinclair/typebox";
import { jsonResult, optionalStringEnum, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getSupabase } from "../lib/supabase.js";

const STATUS_VALUES = ["backlog", "in_progress", "completed", "blocked", "waiting"] as const;
const PRIORITY_VALUES = ["p1", "p2", "p3", "p4", "p5"] as const;

const TASK_LIST_COLUMNS =
  "id, title, status_label, priority_level, top_level_category, project_id, due_date, completed_at, is_recurring, created_at, updated_at";

export function registerTaskTools(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "sophon_list_tasks",
    label: "Sophon: List Tasks",
    description: "List tasks from Sophon with optional filters",
    parameters: Type.Object({
      status: optionalStringEnum(STATUS_VALUES),
      priority: optionalStringEnum(PRIORITY_VALUES),
      project_id: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      due_before: Type.Optional(Type.String({ format: "date-time" })),
      due_after: Type.Optional(Type.String({ format: "date-time" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      let query = supabase
        .from("tasks")
        .select(TASK_LIST_COLUMNS)
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(params.limit ?? 25);

      if (params.status) query = query.eq("status_label", params.status);
      if (params.priority) query = query.eq("priority_level", params.priority);
      if (params.project_id) query = query.eq("project_id", params.project_id);
      if (params.category) query = query.eq("top_level_category", params.category);
      if (params.due_before) query = query.lte("due_date", params.due_before);
      if (params.due_after) query = query.gte("due_date", params.due_after);

      const { data, error } = await query;
      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_get_task",
    label: "Sophon: Get Task",
    description: "Get a single task by ID with full details",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.from("tasks").select("*").eq("id", params.id).single();
      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_create_task",
    label: "Sophon: Create Task",
    description: "Create a new task in Sophon",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      description: Type.Optional(Type.String()),
      desired_outcome: Type.Optional(Type.String()),
      status_label: optionalStringEnum(STATUS_VALUES),
      priority_level: optionalStringEnum(PRIORITY_VALUES),
      top_level_category: Type.Optional(Type.String()),
      project_id: Type.Optional(Type.String({ format: "uuid" })),
      due_date: Type.Optional(Type.String({ format: "date-time" })),
      team_id: Type.Optional(Type.String({ format: "uuid" })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("tasks")
        .insert({
          title: params.title,
          description: params.description,
          desired_outcome: params.desired_outcome,
          status_label: params.status_label ?? "backlog",
          priority_level: params.priority_level ?? "p3",
          top_level_category: params.top_level_category ?? "Uncategorized",
          project_id: params.project_id,
          due_date: params.due_date,
          team_id: params.team_id,
        })
        .select()
        .single();
      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_update_task",
    label: "Sophon: Update Task",
    description: "Update fields on an existing task",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      title: Type.Optional(Type.String({ minLength: 1 })),
      description: Type.Optional(Type.String()),
      desired_outcome: Type.Optional(Type.String()),
      status_label: optionalStringEnum(STATUS_VALUES),
      priority_level: optionalStringEnum(PRIORITY_VALUES),
      top_level_category: Type.Optional(Type.String()),
      project_id: Type.Optional(Type.String({ format: "uuid" })),
      due_date: Type.Optional(Type.String({ format: "date-time" })),
    }),
    async execute(_toolCallId, params) {
      const { id, ...fields } = params;
      const updates: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          updates[key] = value;
        }
      }

      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("tasks")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_complete_task",
    label: "Sophon: Complete Task",
    description: "Mark a task as completed",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("tasks")
        .update({
          status_label: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", params.id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_archive_task",
    label: "Sophon: Archive Task",
    description: "Archive (soft-delete) a task",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("tasks")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", params.id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult({ task: data, reason: params.reason ?? null });
    },
  });
}
