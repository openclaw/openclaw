import type { SupabaseClient } from "./supabase.js";
import {
  repoCreateTask,
  repoFetchTask,
  repoListTasks,
  repoUpdateTask,
} from "./tasks-repository.js";
import type { CreateTaskInput, ListTasksParams, Task, UpdateTaskInput } from "./types.js";

export async function serviceFetchTask(
  client: SupabaseClient,
  id: string,
  includeDeleted = false,
): Promise<Task | null> {
  return repoFetchTask(client, id, includeDeleted);
}

export async function serviceListTasks(
  client: SupabaseClient,
  params: ListTasksParams,
): Promise<{ items: Task[]; total: number }> {
  return repoListTasks(client, params);
}

export async function serviceCreateTask(
  client: SupabaseClient,
  input: CreateTaskInput,
): Promise<Task> {
  return repoCreateTask(client, {
    titulo: input.titulo,
    descricao: input.descricao ?? null,
    status: input.status ?? "pendente",
    categoria: input.categoria ?? "backlog",
    prioridade: input.prioridade ?? 3,
    pessoa: input.pessoa ?? null,
    origem: input.origem ?? "iris",
    vencimento_em: input.vencimento_em ?? null,
    metadata: input.metadata ?? {},
  });
}

export async function serviceUpdateTask(
  client: SupabaseClient,
  id: string,
  input: UpdateTaskInput,
): Promise<Task | null> {
  // Build patch object with only provided fields
  const patch: Record<string, unknown> = {};
  if (input.titulo !== undefined) patch.titulo = input.titulo.trim();
  if (input.descricao !== undefined) patch.descricao = input.descricao;
  if (input.status !== undefined) patch.status = input.status;
  if (input.categoria !== undefined) patch.categoria = input.categoria;
  if (input.prioridade !== undefined) patch.prioridade = input.prioridade;
  if (input.pessoa !== undefined) patch.pessoa = input.pessoa;
  if (input.origem !== undefined) patch.origem = input.origem;
  if (input.vencimento_em !== undefined) patch.vencimento_em = input.vencimento_em;
  if (input.concluido_por !== undefined) patch.concluido_por = input.concluido_por;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  return repoUpdateTask(client, id, patch);
}

/** Soft delete: set deleted_at = now(). */
export async function serviceSoftDeleteTask(
  client: SupabaseClient,
  id: string,
): Promise<{ id: string; deleted_at: string } | null> {
  const deletedAt = new Date().toISOString();
  const updated = await repoUpdateTask(client, id, { deleted_at: deletedAt });
  if (!updated) return null;
  return { id: updated.id, deleted_at: updated.deleted_at ?? deletedAt };
}

/** Restore: clear deleted_at. */
export async function serviceRestoreTask(client: SupabaseClient, id: string): Promise<Task | null> {
  // Fetch including deleted to verify it exists
  const existing = await repoFetchTask(client, id, true);
  if (!existing) return null;
  return repoUpdateTask(client, id, { deleted_at: null });
}
