import type { SupabaseClient } from "./supabase.js";
import {
  supabaseFetchTask,
  supabaseInsertTask,
  supabaseListTasks,
  supabaseUpdateTask,
} from "./supabase.js";
import type { ListTasksParams, Task } from "./types.js";

/** Build Supabase REST query string from list params. */
function buildListQuery(params: ListTasksParams): string {
  const parts: string[] = ["select=*"];

  if (!params.include_deleted) {
    parts.push("deleted_at=is.null");
  }
  if (params.status) {
    parts.push(`status=eq.${encodeURIComponent(params.status)}`);
  }
  if (params.categoria) {
    parts.push(`categoria=eq.${encodeURIComponent(params.categoria)}`);
  }
  if (params.pessoa) {
    parts.push(`pessoa=eq.${encodeURIComponent(params.pessoa)}`);
  }
  // Search via ilike on titulo and descricao
  if (params.search) {
    const term = encodeURIComponent(`*${params.search}*`);
    parts.push(`or=(titulo.ilike.${term},descricao.ilike.${term})`);
  }

  const dir = params.sort_dir === "asc" ? "asc" : "desc";
  parts.push(`order=${params.sort_by}.${dir}`);
  parts.push(`limit=${params.limit}`);
  parts.push(`offset=${params.offset}`);

  return parts.join("&");
}

export async function repoListTasks(
  client: SupabaseClient,
  params: ListTasksParams,
): Promise<{ items: Task[]; total: number }> {
  const query = buildListQuery(params);
  return supabaseListTasks(client, query);
}

export async function repoFetchTask(
  client: SupabaseClient,
  id: string,
  includeDeleted = false,
): Promise<Task | null> {
  return supabaseFetchTask(client, id, includeDeleted);
}

export async function repoCreateTask(
  client: SupabaseClient,
  data: Record<string, unknown>,
): Promise<Task> {
  return supabaseInsertTask(client, data);
}

export async function repoUpdateTask(
  client: SupabaseClient,
  id: string,
  data: Record<string, unknown>,
): Promise<Task | null> {
  return supabaseUpdateTask(client, id, data);
}
