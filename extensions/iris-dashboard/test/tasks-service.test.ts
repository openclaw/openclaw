import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "../src/supabase.js";
import type { Task } from "../src/types.js";

// ─── Mock repository ───────────────────────────────────────────────────────────

vi.mock("../src/tasks-repository.js", () => ({
  repoListTasks: vi.fn(),
  repoFetchTask: vi.fn(),
  repoCreateTask: vi.fn(),
  repoUpdateTask: vi.fn(),
}));

import * as repo from "../src/tasks-repository.js";
import {
  serviceCreateTask,
  serviceFetchTask,
  serviceListTasks,
  serviceRestoreTask,
  serviceSoftDeleteTask,
  serviceUpdateTask,
} from "../src/tasks-service.js";

const mockClient = {} as SupabaseClient;

const baseTask: Task = {
  id: "00000000-0000-0000-0000-000000000001",
  titulo: "Teste",
  descricao: null,
  status: "pendente",
  categoria: "backlog",
  prioridade: 3,
  pessoa: null,
  origem: "iris",
  vencimento_em: null,
  concluido_em: null,
  concluido_por: null,
  metadata: {},
  criado_em: "2026-02-27T00:00:00Z",
  atualizado_em: "2026-02-27T00:00:00Z",
  deleted_at: null,
};

describe("serviceCreateTask", () => {
  it("calls repoCreateTask with defaults applied", async () => {
    vi.mocked(repo.repoCreateTask).mockResolvedValueOnce(baseTask);
    const result = await serviceCreateTask(mockClient, { titulo: "Teste" });
    expect(result).toEqual(baseTask);
    expect(repo.repoCreateTask).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({
        titulo: "Teste",
        status: "pendente",
        categoria: "backlog",
        prioridade: 3,
        origem: "iris",
      }),
    );
  });
});

describe("serviceUpdateTask", () => {
  it("only includes provided fields in patch", async () => {
    const updated = { ...baseTask, status: "concluido" as const };
    vi.mocked(repo.repoUpdateTask).mockResolvedValueOnce(updated);
    await serviceUpdateTask(mockClient, baseTask.id, { status: "concluido" });
    expect(repo.repoUpdateTask).toHaveBeenCalledWith(mockClient, baseTask.id, {
      status: "concluido",
    });
  });

  it("returns null when task not found", async () => {
    vi.mocked(repo.repoUpdateTask).mockResolvedValueOnce(null);
    const result = await serviceUpdateTask(mockClient, "nonexistent", { titulo: "X" });
    expect(result).toBeNull();
  });
});

describe("serviceSoftDeleteTask", () => {
  it("sets deleted_at on the task", async () => {
    const deleted = { ...baseTask, deleted_at: "2026-02-27T10:00:00Z" };
    vi.mocked(repo.repoUpdateTask).mockResolvedValueOnce(deleted);
    const result = await serviceSoftDeleteTask(mockClient, baseTask.id);
    expect(result?.id).toBe(baseTask.id);
    expect(result?.deleted_at).toBeTruthy();
  });

  it("returns null when task not found", async () => {
    vi.mocked(repo.repoUpdateTask).mockResolvedValueOnce(null);
    const result = await serviceSoftDeleteTask(mockClient, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("serviceRestoreTask", () => {
  it("fetches task with include_deleted=true, then clears deleted_at", async () => {
    const deletedTask = { ...baseTask, deleted_at: "2026-02-27T10:00:00Z" };
    const restored = { ...baseTask, deleted_at: null };
    vi.mocked(repo.repoFetchTask).mockResolvedValueOnce(deletedTask);
    vi.mocked(repo.repoUpdateTask).mockResolvedValueOnce(restored);
    const result = await serviceRestoreTask(mockClient, baseTask.id);
    expect(repo.repoFetchTask).toHaveBeenCalledWith(mockClient, baseTask.id, true);
    expect(result?.deleted_at).toBeNull();
  });

  it("returns null when task not found", async () => {
    vi.mocked(repo.repoFetchTask).mockResolvedValueOnce(null);
    const result = await serviceRestoreTask(mockClient, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("serviceListTasks", () => {
  it("delegates to repoListTasks", async () => {
    vi.mocked(repo.repoListTasks).mockResolvedValueOnce({ items: [baseTask], total: 1 });
    const params = {
      limit: 50,
      offset: 0,
      include_deleted: false,
      sort_by: "criado_em" as const,
      sort_dir: "desc" as const,
    };
    const result = await serviceListTasks(mockClient, params);
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("serviceFetchTask", () => {
  it("delegates to repoFetchTask", async () => {
    vi.mocked(repo.repoFetchTask).mockResolvedValueOnce(baseTask);
    const result = await serviceFetchTask(mockClient, baseTask.id);
    expect(result?.id).toBe(baseTask.id);
  });
});
