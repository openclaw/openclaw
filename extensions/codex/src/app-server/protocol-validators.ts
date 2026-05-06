import AjvPkg, { type ValidateFunction } from "ajv";
import dynamicToolCallParamsSchema from "./protocol-generated/json/DynamicToolCallParams.json" with { type: "json" };
import errorNotificationSchema from "./protocol-generated/json/v2/ErrorNotification.json" with { type: "json" };
import modelListResponseSchema from "./protocol-generated/json/v2/ModelListResponse.json" with { type: "json" };
import threadResumeResponseSchema from "./protocol-generated/json/v2/ThreadResumeResponse.json" with { type: "json" };
import threadStartResponseSchema from "./protocol-generated/json/v2/ThreadStartResponse.json" with { type: "json" };
import turnCompletedNotificationSchema from "./protocol-generated/json/v2/TurnCompletedNotification.json" with { type: "json" };
import turnStartResponseSchema from "./protocol-generated/json/v2/TurnStartResponse.json" with { type: "json" };
import type { v2 } from "./protocol-generated/typescript/index.js";
import type {
  CodexDynamicToolCallParams,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurn,
  CodexTurnStartResponse,
} from "./protocol.js";

type AjvInstance = import("ajv").default;

const AjvCtor = AjvPkg as unknown as new (opts?: object) => AjvInstance;
const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  useDefaults: true,
  validateFormats: false,
});

const validateDynamicToolCallParams = ajv.compile<CodexDynamicToolCallParams>(
  dynamicToolCallParamsSchema,
);
const validateErrorNotification = ajv.compile<v2.ErrorNotification>(errorNotificationSchema);
const validateModelListResponse = ajv.compile<v2.ModelListResponse>(modelListResponseSchema);
const validateThreadResumeResponse = ajv.compile<CodexThreadResumeResponse>(
  threadResumeResponseSchema,
);
const validateThreadStartResponse =
  ajv.compile<CodexThreadStartResponse>(threadStartResponseSchema);
const validateTurnCompletedNotification = ajv.compile<v2.TurnCompletedNotification>(
  turnCompletedNotificationSchema,
);
const validateTurnStartResponse = ajv.compile<CodexTurnStartResponse>(turnStartResponseSchema);

export function assertCodexThreadStartResponse(value: unknown): CodexThreadStartResponse {
  return assertCodexShape(
    validateThreadStartResponse,
    normalizeThreadPermissionProfile(value),
    "thread/start response",
  );
}

export function assertCodexThreadResumeResponse(value: unknown): CodexThreadResumeResponse {
  return assertCodexShape(
    validateThreadResumeResponse,
    normalizeThreadPermissionProfile(value),
    "thread/resume response",
  );
}

export function assertCodexTurnStartResponse(value: unknown): CodexTurnStartResponse {
  return assertCodexShape(
    validateTurnStartResponse,
    normalizeTurnStartResponse(value),
    "turn/start response",
  );
}

export function readCodexDynamicToolCallParams(
  value: unknown,
): CodexDynamicToolCallParams | undefined {
  return readCodexShape(validateDynamicToolCallParams, value);
}

export function readCodexErrorNotification(value: unknown): v2.ErrorNotification | undefined {
  return readCodexShape(validateErrorNotification, value);
}

export function readCodexModelListResponse(value: unknown): v2.ModelListResponse | undefined {
  return readCodexShape(validateModelListResponse, value);
}

export function readCodexTurn(value: unknown): CodexTurn | undefined {
  const response = readCodexShape(validateTurnStartResponse, { turn: normalizeTurn(value) });
  return response?.turn;
}

export function readCodexTurnCompletedNotification(
  value: unknown,
): v2.TurnCompletedNotification | undefined {
  return readCodexShape(
    validateTurnCompletedNotification,
    normalizeTurnCompletedNotification(value),
  );
}

function assertCodexShape<T>(validate: ValidateFunction<T>, value: unknown, label: string): T {
  if (validate(value)) {
    return value;
  }
  throw new Error(`Invalid Codex app-server ${label}: ${formatAjvErrors(validate)}`);
}

function readCodexShape<T>(validate: ValidateFunction<T>, value: unknown): T | undefined {
  return validate(value) ? value : undefined;
}

function normalizeThreadPermissionProfile(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const response = value as { permissionProfile?: unknown };
  const permissionProfile = normalizePermissionProfile(response.permissionProfile);
  if (permissionProfile === response.permissionProfile) {
    return value;
  }
  return { ...value, permissionProfile };
}

function normalizePermissionProfile(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const profile = value as { type?: unknown; fileSystem?: unknown };
  if (profile.type !== "managed") {
    return value;
  }
  const fileSystem = normalizePermissionProfileFileSystem(profile.fileSystem);
  if (fileSystem === profile.fileSystem) {
    return value;
  }
  return { ...value, fileSystem };
}

function normalizePermissionProfileFileSystem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const fileSystem = value as { type?: unknown; entries?: unknown };
  if (fileSystem.type !== "restricted" || !Array.isArray(fileSystem.entries)) {
    return value;
  }
  let changed = false;
  const entries = fileSystem.entries.map((entry) => {
    const normalized = normalizePermissionProfileFileSystemEntry(entry);
    if (normalized !== entry) {
      changed = true;
    }
    return normalized;
  });
  return changed ? { ...value, entries } : value;
}

function normalizePermissionProfileFileSystemEntry(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const entry = value as { path?: unknown };
  const normalizedPath = normalizePermissionProfileFileSystemPath(entry.path);
  return normalizedPath === entry.path ? value : { ...value, path: normalizedPath };
}

function normalizePermissionProfileFileSystemPath(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const path = value as { type?: unknown; value?: unknown };
  if (path.type !== "special" || !path.value || typeof path.value !== "object") {
    return value;
  }
  const special = path.value as { kind?: unknown; subpath?: unknown };
  if (typeof special.kind !== "string" || isKnownPermissionProfileSpecialPathKind(special.kind)) {
    return value;
  }
  return {
    ...value,
    value: {
      kind: "unknown",
      path: special.kind,
      subpath:
        typeof special.subpath === "string" || special.subpath === null ? special.subpath : null,
    },
  };
}

function isKnownPermissionProfileSpecialPathKind(kind: string): boolean {
  return (
    kind === "root" ||
    kind === "minimal" ||
    kind === "project_roots" ||
    kind === "tmpdir" ||
    kind === "slash_tmp" ||
    kind === "unknown"
  );
}

function normalizeTurn(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return {
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...value,
    items: Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items.map(normalizeThreadItem)
      : [],
  };
}

function normalizeThreadItem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const item = value as { type?: unknown };
  switch (item.type) {
    case "agentMessage":
      return { phase: null, memoryCitation: null, ...value };
    case "plan":
      return { text: "", ...value };
    case "reasoning":
      return { summary: [], content: [], ...value };
    case "dynamicToolCall":
      return {
        namespace: null,
        arguments: null,
        status: "completed",
        contentItems: null,
        success: null,
        durationMs: null,
        ...value,
      };
    default:
      return value;
  }
}

function normalizeTurnStartResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("turn" in value)) {
    return value;
  }
  return {
    ...value,
    turn: normalizeTurn((value as { turn?: unknown }).turn),
  };
}

function normalizeTurnCompletedNotification(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("turn" in value)) {
    return value;
  }
  return {
    ...value,
    turn: normalizeTurn((value as { turn?: unknown }).turn),
  };
}

function formatAjvErrors(validate: ValidateFunction): string {
  const errors = validate.errors;
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }
  return ajv.errorsText(errors, { separator: "; " });
}
