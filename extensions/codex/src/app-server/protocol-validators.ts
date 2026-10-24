import path from "node:path";
import { normalizeJsonSchemaForTypeBox } from "openclaw/plugin-sdk/json-schema-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Compile } from "typebox/compile";
import { readCodexNotificationScope } from "./notification-correlation.js";
import rawDynamicToolCallParamsSchema from "./protocol-generated/json/DynamicToolCallParams.json" with { type: "json" };
import sharedDefinitionsSchema from "./protocol-generated/json/v2/CodexAppServerProtocolDefinitions.json" with { type: "json" };
import rawErrorNotificationSchema from "./protocol-generated/json/v2/ErrorNotification.json" with { type: "json" };
import rawModelListResponseSchema from "./protocol-generated/json/v2/ModelListResponse.json" with { type: "json" };
import rawThreadResumeResponseSchema from "./protocol-generated/json/v2/ThreadResumeResponse.json" with { type: "json" };
import rawThreadStartResponseSchema from "./protocol-generated/json/v2/ThreadStartResponse.json" with { type: "json" };
import rawTurnCompletedNotificationSchema from "./protocol-generated/json/v2/TurnCompletedNotification.json" with { type: "json" };
import rawTurnStartResponseSchema from "./protocol-generated/json/v2/TurnStartResponse.json" with { type: "json" };
import {
  isJsonObject,
  type CodexDynamicToolCallParams,
  type CodexErrorNotification,
  type CodexModelListResponse,
  type CodexPreparedServerNotification,
  type CodexServerNotification,
  type CodexThread,
  type CodexThreadForkResponse,
  type CodexThreadItem,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnCompletedNotification,
  type CodexTurnStartResponse,
} from "./protocol.js";

export function readSupervisionResponseThreadId(value: unknown): unknown {
  const thread = isRecord(value) ? value.thread : undefined;
  return isRecord(thread) ? thread.id : undefined;
}

export function resolveCodexThreadRolloutPath(thread: CodexThread): string | undefined {
  const rolloutPath = thread.path?.trim();
  if (
    !rolloutPath ||
    !path.isAbsolute(rolloutPath) ||
    path.extname(rolloutPath) !== ".jsonl" ||
    !path.basename(rolloutPath).includes(thread.id)
  ) {
    return undefined;
  }
  return rolloutPath;
}

type ValidationError = {
  instancePath?: string;
  message?: string;
};

type CodexValidator<T> = {
  check: (value: unknown) => value is T;
  errors: (value: unknown) => ValidationError[];
};

// Compilation-only resource IDs let TypeBox resolve the generated relative refs.
const schemaBaseUrl = "https://openclaw.invalid/codex/";
const sharedDefinitionsId = new URL("v2/CodexAppServerProtocolDefinitions.json", schemaBaseUrl)
  .href;
const schemaContext = {
  [sharedDefinitionsId]: normalizeJsonSchemaForTypeBox({
    ...sharedDefinitionsSchema,
    $id: sharedDefinitionsId,
  }),
};

function compileCodexSchema<T>(
  rawSchema: Record<string, unknown>,
  name: string,
): CodexValidator<T> {
  const validator = Compile(
    schemaContext,
    normalizeJsonSchemaForTypeBox({ ...rawSchema, $id: new URL(name, schemaBaseUrl).href }),
  );
  return {
    check: (value): value is T => validator.Check(value),
    errors: (value) => [...validator.Errors(value)],
  };
}

const validateDynamicToolCallParams = compileCodexSchema<CodexDynamicToolCallParams>(
  rawDynamicToolCallParamsSchema,
  "DynamicToolCallParams.json",
);
const validateErrorNotification = compileCodexSchema<CodexErrorNotification>(
  rawErrorNotificationSchema,
  "v2/ErrorNotification.json",
);
const validateModelListResponse = compileCodexSchema<CodexModelListResponse>(
  rawModelListResponseSchema,
  "v2/ModelListResponse.json",
);
const validateThreadResumeResponse = compileCodexSchema<CodexThreadResumeResponse>(
  rawThreadResumeResponseSchema,
  "v2/ThreadResumeResponse.json",
);
const validateThreadStartResponse = compileCodexSchema<CodexThreadStartResponse>(
  rawThreadStartResponseSchema,
  "v2/ThreadStartResponse.json",
);
const validateTurnCompletedNotification = compileCodexSchema<CodexTurnCompletedNotification>(
  rawTurnCompletedNotificationSchema,
  "v2/TurnCompletedNotification.json",
);
const validateTurnStartResponse = compileCodexSchema<CodexTurnStartResponse>(
  rawTurnStartResponseSchema,
  "v2/TurnStartResponse.json",
);

export function assertCodexThreadStartResponse(value: unknown): CodexThreadStartResponse {
  return assertCodexShape(validateThreadStartResponse, value, "thread/start response");
}

export function assertCodexThreadForkResponse(value: unknown): CodexThreadForkResponse {
  return assertCodexShape(validateThreadStartResponse, value, "thread/fork response");
}

export function assertCodexThreadResumeResponse(value: unknown): CodexThreadResumeResponse {
  return assertCodexShape(validateThreadResumeResponse, value, "thread/resume response");
}

export class CodexThreadDirectInputError extends Error {
  constructor(threadId: string) {
    super(
      `Codex thread ${threadId} is controlled by its parent and cannot accept direct input. ` +
        "Continue its parent thread, or use /new for a separate OpenClaw session.",
    );
    this.name = "CodexThreadDirectInputError";
  }
}

/** Native V2 children allow observation, but only their parent may supply turn input. */
export function assertCodexThreadAcceptsDirectInput(
  thread: Pick<CodexThread, "id" | "canAcceptDirectInput">,
): void {
  // Unloaded threads report null; only an explicit native refusal is conclusive.
  if (thread.canAcceptDirectInput === false) {
    throw new CodexThreadDirectInputError(thread.id);
  }
}

export function assertCodexTurnStartResponse(value: unknown): CodexTurnStartResponse {
  return assertCodexShape(validateTurnStartResponse, value, "turn/start response");
}

/** Prompt echoes and attested managed-hook continuations cannot admit native capabilities. */
export function assertCodexPassiveTurnItems(
  items: readonly CodexThreadItem[],
  prompt: string,
  taskLabel: string,
  options: { allowManagedHookPrompts?: boolean } = {},
): void {
  let promptEchoSeen = false;
  for (const item of items) {
    if (item.type === "agentMessage" || item.type === "reasoning") {
      continue;
    }
    if (
      item.type === "hookPrompt" &&
      options.allowManagedHookPrompts === true &&
      Array.isArray(item.fragments) &&
      item.fragments.length > 0 &&
      item.fragments.every(
        (fragment) =>
          isJsonObject(fragment) &&
          typeof fragment.text === "string" &&
          typeof fragment.hookRunId === "string" &&
          fragment.hookRunId.trim().length > 0,
      )
    ) {
      continue;
    }
    if (item.type === "userMessage" && !promptEchoSeen) {
      const content = Array.isArray(item.content) ? item.content : [];
      const input = content[0];
      if (
        content.length === 1 &&
        isJsonObject(input) &&
        input.type === "text" &&
        input.text === prompt
      ) {
        promptEchoSeen = true;
        continue;
      }
    }
    throw new Error(`Codex ${taskLabel} returned unexpected native item: ${item.type}`);
  }
}

export function readCodexDynamicToolCallParams(
  value: unknown,
): CodexDynamicToolCallParams | undefined {
  return readCodexShape(validateDynamicToolCallParams, value);
}

export function readCodexErrorNotification(value: unknown): CodexErrorNotification | undefined {
  return readCodexShape(validateErrorNotification, value);
}

export function assertCodexModelListResponse(value: unknown): CodexModelListResponse {
  return assertCodexShape(validateModelListResponse, value, "model/list response");
}

function readCodexTurnCompletedNotification(
  value: unknown,
): CodexTurnCompletedNotification | undefined {
  const notification = readCodexShape(validateTurnCompletedNotification, value);
  // Turn is shared with turn/start, but only terminal states belong in this notification.
  return notification?.turn.status === "inProgress" ? undefined : notification;
}

/** Normalize the native terminal snapshot once before receipt and queued projection fan-out. */
export function prepareCodexServerNotification(
  notification: CodexServerNotification,
  scope = readCodexNotificationScope(notification.params),
): CodexPreparedServerNotification {
  return {
    ...notification,
    ...scope,
    completedTurn:
      notification.method === "turn/completed"
        ? readCodexTurnCompletedNotification(notification.params)?.turn
        : undefined,
  };
}

export function assertExactSupervisionModelSelection(
  value: { model?: string | null; modelProvider?: string | null },
  expected: { model: string; modelProvider: string; operation: string },
): void {
  if (value.model !== expected.model || value.modelProvider !== expected.modelProvider) {
    throw new Error(
      `Codex supervision ${expected.operation} changed native model selection: ` +
        `${value.modelProvider ?? "unknown"}/${value.model ?? "unknown"}`,
    );
  }
}

function assertCodexShape<T>(validate: CodexValidator<T>, value: unknown, label: string): T {
  if (validate.check(value)) {
    return value;
  }
  throw new Error(`Invalid Codex app-server ${label}: ${formatValidationErrors(validate, value)}`);
}

function readCodexShape<T>(validate: CodexValidator<T>, value: unknown): T | undefined {
  return validate.check(value) ? value : undefined;
}

function formatValidationErrors(validate: CodexValidator<unknown>, value: unknown): string {
  const errors = validate.errors(value);
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }
  return errors
    .map((error) => {
      const message = error.message?.trim() || "schema validation failed";
      return error.instancePath ? `${error.instancePath} ${message}` : message;
    })
    .join("; ");
}
