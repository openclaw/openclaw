export type TaskStatus = "pendente" | "em_andamento" | "concluido" | "cancelado";
export type TaskCategoria = "follow_up" | "backlog" | "urgente" | "proximo" | "outros";
export type TaskOrigem = "iris" | "lucas" | "sistema";
export type TaskSortBy = "criado_em" | "atualizado_em" | "vencimento_em" | "prioridade";
export type SortDir = "asc" | "desc";

export type Task = {
  id: string;
  titulo: string;
  descricao: string | null;
  status: TaskStatus;
  categoria: TaskCategoria;
  prioridade: number;
  pessoa: string | null;
  origem: TaskOrigem;
  vencimento_em: string | null;
  concluido_em: string | null;
  concluido_por: string | null;
  metadata: Record<string, unknown>;
  criado_em: string;
  atualizado_em: string;
  deleted_at: string | null;
};

export type ListTasksParams = {
  status?: string;
  categoria?: string;
  pessoa?: string;
  search?: string;
  limit: number;
  offset: number;
  include_deleted: boolean;
  sort_by: TaskSortBy;
  sort_dir: SortDir;
};

export type CreateTaskInput = {
  titulo: string;
  descricao?: string | null;
  status?: TaskStatus;
  categoria?: TaskCategoria;
  prioridade?: number;
  pessoa?: string | null;
  origem?: TaskOrigem;
  vencimento_em?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateTaskInput = {
  titulo?: string;
  descricao?: string | null;
  status?: TaskStatus;
  categoria?: TaskCategoria;
  prioridade?: number;
  pessoa?: string | null;
  origem?: TaskOrigem;
  vencimento_em?: string | null;
  concluido_por?: string | null;
  metadata?: Record<string, unknown>;
};

export type ApiSuccessResponse<T> = { ok: true; data: T };
export type ApiErrorResponse = {
  ok: false;
  error: { code: string; message: string; details?: unknown };
};
export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
