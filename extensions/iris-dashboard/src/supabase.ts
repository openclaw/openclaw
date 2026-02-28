import type { DashboardConfig } from "./config.js";
import type { Task } from "./types.js";

export type SupabaseClient = {
  config: DashboardConfig;
};

export function createSupabaseClient(config: DashboardConfig): SupabaseClient {
  return { config };
}

function serviceHeaders(config: DashboardConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.supabaseServiceKey}`,
    apikey: config.supabaseServiceKey,
  };
}

/** Fetch tasks from Supabase REST with count header.
 *  Returns items array and total count from content-range. */
export async function supabaseListTasks(
  client: SupabaseClient,
  queryString: string,
): Promise<{ items: Task[]; total: number }> {
  const url = `${client.config.supabaseUrl}/rest/v1/tasks?${queryString}`;
  const res = await fetch(url, {
    headers: { ...serviceHeaders(client.config), Prefer: "count=exact" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase list error ${res.status}: ${body}`);
  }
  const items = (await res.json()) as Task[];
  const range = res.headers.get("content-range");
  // content-range format: "0-49/123"
  const total = range ? parseInt(range.split("/")[1] ?? "0", 10) || items.length : items.length;
  return { items, total };
}

/** Fetch a single task by id. Returns null if not found. */
export async function supabaseFetchTask(
  client: SupabaseClient,
  id: string,
  includeDeleted = false,
): Promise<Task | null> {
  const del = includeDeleted ? "" : "&deleted_at=is.null";
  const url = `${client.config.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&select=*${del}`;
  const res = await fetch(url, { headers: serviceHeaders(client.config) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase fetch error ${res.status}: ${body}`);
  }
  const rows = (await res.json()) as Task[];
  return rows[0] ?? null;
}

/** Insert a new task. Returns the created row. */
export async function supabaseInsertTask(
  client: SupabaseClient,
  data: Record<string, unknown>,
): Promise<Task> {
  const url = `${client.config.supabaseUrl}/rest/v1/tasks`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...serviceHeaders(client.config), Prefer: "return=representation" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase insert error ${res.status}: ${body}`);
  }
  const rows = (await res.json()) as Task[];
  if (!rows[0]) throw new Error("Supabase insert returned no rows");
  return rows[0];
}

/** Patch a task by id. Returns updated row or null if not found. */
export async function supabaseUpdateTask(
  client: SupabaseClient,
  id: string,
  data: Record<string, unknown>,
): Promise<Task | null> {
  const url = `${client.config.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...serviceHeaders(client.config), Prefer: "return=representation" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase update error ${res.status}: ${body}`);
  }
  const rows = (await res.json()) as Task[];
  return rows[0] ?? null;
}

/** Fetch pending/in-progress tasks for heartbeat (no deleted). */
export async function supabaseFetchActiveTasksForHeartbeat(
  client: SupabaseClient,
): Promise<Task[]> {
  const url =
    `${client.config.supabaseUrl}/rest/v1/tasks` +
    `?deleted_at=is.null&status=in.(pendente,em_andamento)` +
    `&order=prioridade.asc,criado_em.asc&limit=50&select=*`;
  const res = await fetch(url, { headers: serviceHeaders(client.config) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase heartbeat fetch error ${res.status}: ${body}`);
  }
  return (await res.json()) as Task[];
}
