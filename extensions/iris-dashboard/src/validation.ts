import type {
  CreateTaskInput,
  ListTasksParams,
  SortDir,
  TaskCategoria,
  TaskOrigem,
  TaskSortBy,
  TaskStatus,
  UpdateTaskInput,
} from "./types.js";

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; error: string };

const VALID_STATUSES: TaskStatus[] = ["pendente", "em_andamento", "concluido", "cancelado"];
const VALID_CATEGORIAS: TaskCategoria[] = ["follow_up", "backlog", "urgente", "proximo", "outros"];
const VALID_ORIGENS: TaskOrigem[] = ["iris", "lucas", "sistema"];
const VALID_SORT_BY: TaskSortBy[] = ["criado_em", "atualizado_em", "vencimento_em", "prioridade"];
const VALID_SORT_DIR: SortDir[] = ["asc", "desc"];

export function validateCreateTask(body: unknown): ValidationResult<CreateTaskInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (!b.titulo || typeof b.titulo !== "string") {
    return { ok: false, error: "titulo is required and must be a string" };
  }
  const titulo = b.titulo.trim();
  if (titulo.length < 1 || titulo.length > 200) {
    return { ok: false, error: "titulo must be between 1 and 200 characters" };
  }

  if (b.status !== undefined && !VALID_STATUSES.includes(b.status as TaskStatus)) {
    return { ok: false, error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
  }
  if (b.categoria !== undefined && !VALID_CATEGORIAS.includes(b.categoria as TaskCategoria)) {
    return {
      ok: false,
      error: `categoria must be one of: ${VALID_CATEGORIAS.join(", ")}`,
    };
  }
  if (
    b.prioridade !== undefined &&
    (typeof b.prioridade !== "number" || b.prioridade < 1 || b.prioridade > 5)
  ) {
    return { ok: false, error: "prioridade must be a number between 1 and 5" };
  }
  if (b.origem !== undefined && !VALID_ORIGENS.includes(b.origem as TaskOrigem)) {
    return { ok: false, error: `origem must be one of: ${VALID_ORIGENS.join(", ")}` };
  }
  if (
    b.metadata !== undefined &&
    (typeof b.metadata !== "object" || Array.isArray(b.metadata) || b.metadata === null)
  ) {
    return { ok: false, error: "metadata must be a JSON object" };
  }

  return {
    ok: true,
    data: {
      titulo,
      descricao: typeof b.descricao === "string" ? b.descricao : null,
      status: (b.status as TaskStatus | undefined) ?? "pendente",
      categoria: (b.categoria as TaskCategoria | undefined) ?? "backlog",
      prioridade: (b.prioridade as number | undefined) ?? 3,
      pessoa: typeof b.pessoa === "string" ? b.pessoa : null,
      origem: (b.origem as TaskOrigem | undefined) ?? "iris",
      vencimento_em: typeof b.vencimento_em === "string" ? b.vencimento_em : null,
      metadata: (b.metadata as Record<string, unknown> | undefined) ?? {},
    },
  };
}

export function validateUpdateTask(body: unknown): ValidationResult<UpdateTaskInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  // Disallow immutable fields
  for (const field of ["id", "criado_em", "atualizado_em"]) {
    if (field in b) {
      return { ok: false, error: `Cannot update immutable field: ${field}` };
    }
  }

  if (b.titulo !== undefined) {
    if (typeof b.titulo !== "string") {
      return { ok: false, error: "titulo must be a string" };
    }
    const titulo = b.titulo.trim();
    if (titulo.length < 1 || titulo.length > 200) {
      return { ok: false, error: "titulo must be between 1 and 200 characters" };
    }
  }
  if (b.status !== undefined && !VALID_STATUSES.includes(b.status as TaskStatus)) {
    return { ok: false, error: `status must be one of: ${VALID_STATUSES.join(", ")}` };
  }
  if (b.categoria !== undefined && !VALID_CATEGORIAS.includes(b.categoria as TaskCategoria)) {
    return {
      ok: false,
      error: `categoria must be one of: ${VALID_CATEGORIAS.join(", ")}`,
    };
  }
  if (
    b.prioridade !== undefined &&
    (typeof b.prioridade !== "number" || b.prioridade < 1 || b.prioridade > 5)
  ) {
    return { ok: false, error: "prioridade must be a number between 1 and 5" };
  }
  if (b.origem !== undefined && !VALID_ORIGENS.includes(b.origem as TaskOrigem)) {
    return { ok: false, error: `origem must be one of: ${VALID_ORIGENS.join(", ")}` };
  }
  if (
    b.metadata !== undefined &&
    (typeof b.metadata !== "object" || Array.isArray(b.metadata) || b.metadata === null)
  ) {
    return { ok: false, error: "metadata must be a JSON object" };
  }

  return { ok: true, data: b as UpdateTaskInput };
}

export function validateListParams(query: URLSearchParams): ValidationResult<ListTasksParams> {
  const limitRaw = parseInt(query.get("limit") ?? "50", 10);
  const limit = isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);

  const offsetRaw = parseInt(query.get("offset") ?? "0", 10);
  const offset = isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

  const sort_by = (query.get("sort_by") ?? "criado_em") as TaskSortBy;
  const sort_dir = (query.get("sort_dir") ?? "desc") as SortDir;

  if (!VALID_SORT_BY.includes(sort_by)) {
    return { ok: false, error: `sort_by must be one of: ${VALID_SORT_BY.join(", ")}` };
  }
  if (!VALID_SORT_DIR.includes(sort_dir)) {
    return { ok: false, error: "sort_dir must be asc or desc" };
  }

  return {
    ok: true,
    data: {
      status: query.get("status") ?? undefined,
      categoria: query.get("categoria") ?? undefined,
      pessoa: query.get("pessoa") ?? undefined,
      search: query.get("search") ?? undefined,
      limit,
      offset,
      include_deleted: query.get("include_deleted") === "true",
      sort_by,
      sort_dir,
    },
  };
}
