import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getSupabase } from "../lib/supabase.js";

export function registerNoteTools(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "sophon_list_notes",
    label: "Sophon: List Notes",
    description: "List notes from Sophon with optional filters",
    parameters: Type.Object({
      project_id: Type.Optional(Type.String({ format: "uuid" })),
      task_id: Type.Optional(Type.String({ format: "uuid" })),
      search: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      let query = supabase
        .from("notes")
        .select("id, title, task_id, project_id, created_at, updated_at")
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(params.limit ?? 25);

      if (params.project_id) query = query.eq("project_id", params.project_id);
      if (params.task_id) query = query.eq("task_id", params.task_id);
      if (params.search) query = query.ilike("title", `%${params.search}%`);

      const { data, error } = await query;
      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_get_note",
    label: "Sophon: Get Note",
    description: "Get one note by id with full content",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.from("notes").select("*").eq("id", params.id).single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_create_note",
    label: "Sophon: Create Note",
    description: "Create a note in Sophon",
    parameters: Type.Object({
      title: Type.String({ minLength: 1 }),
      content: Type.Optional(Type.String()),
      task_id: Type.Optional(Type.String({ format: "uuid" })),
      project_id: Type.Optional(Type.String({ format: "uuid" })),
      team_id: Type.Optional(Type.String({ format: "uuid" })),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.from("notes").insert(params).select().single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_update_note",
    label: "Sophon: Update Note",
    description: "Update fields on a note",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      title: Type.Optional(Type.String({ minLength: 1 })),
      content: Type.Optional(Type.String()),
      task_id: Type.Optional(Type.String({ format: "uuid" })),
      project_id: Type.Optional(Type.String({ format: "uuid" })),
    }),
    async execute(_toolCallId, params) {
      const { id, ...fields } = params;
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value;
      }

      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("notes")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult(data);
    },
  });

  api.registerTool({
    name: "sophon_archive_note",
    label: "Sophon: Archive Note",
    description: "Archive (soft-delete) a note",
    parameters: Type.Object({
      id: Type.String({ format: "uuid" }),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from("notes")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", params.id)
        .select()
        .single();

      if (error) throw new Error(`Sophon API error: ${error.message}`);
      return jsonResult({ note: data, reason: params.reason ?? null });
    },
  });
}
