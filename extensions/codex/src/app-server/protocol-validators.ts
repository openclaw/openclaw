import { normalizeJsonSchemaForTypeBox } from "openclaw/plugin-sdk/json-schema-runtime";
/**
 * Runtime validators for Codex app-server protocol payloads, including schema
 * normalization for generated JSON Schema before TypeBox compilation.
 */
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
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
  type CodexThread,
  type CodexThreadForkResponse,
  type CodexThreadItem,
  type CodexThreadResumeResponse,
  type CodexThreadStartResponse,
  type CodexTurnCompletedNotification,
  type CodexTurnStartResponse,
  type CodexUserInput,
} from "./protocol.js";

type ValidationError = {
  instancePath?: string;
  message?: string;
};

type CodexValidator<T> = {
  check: (value: unknown) => value is T;
  errors: (value: unknown) => ValidationError[];
};

const externalDefinitionRefPrefix = "./CodexAppServerProtocolDefinitions.json#/definitions/";
const rootExternalDefinitionRefPrefix = "./v2/CodexAppServerProtocolDefinitions.json#/definitions/";
const localDefinitionRefPrefix = "#/definitions/";

function materializeCodexSchema(
  schema: unknown,
  externalRefPrefix = externalDefinitionRefPrefix,
): unknown {
  const sharedDefinitions: unknown = sharedDefinitionsSchema.definitions;
  if (!isRecord(schema) || !isRecord(sharedDefinitions)) {
    return schema;
  }
  const reachable = collectDefinitionRefs(schema, externalRefPrefix);
  const pending = [...reachable];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) {
      continue;
    }
    const definition = sharedDefinitions[name];
    if (definition === undefined) {
      throw new Error(`Missing generated Codex schema definition: ${name}`);
    }
    for (const dependency of collectDefinitionRefs(definition, localDefinitionRefPrefix)) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        pending.push(dependency);
      }
    }
  }
  if (reachable.size === 0) {
    return schema;
  }
  const definitions = Object.fromEntries(
    Object.entries(sharedDefinitions).filter(([name]) => reachable.has(name)),
  );
  return rewriteDefinitionRefs({ ...schema, definitions }, externalRefPrefix);
}

function collectDefinitionRefs(
  value: unknown,
  prefix: string,
  names = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDefinitionRefs(entry, prefix, names);
    }
  } else if (isRecord(value)) {
    if (typeof value.$ref === "string" && value.$ref.startsWith(prefix)) {
      const name = value.$ref.slice(prefix.length).split("/", 1)[0];
      if (name) {
        names.add(name.replaceAll("~1", "/").replaceAll("~0", "~"));
      }
    }
    for (const entry of Object.values(value)) {
      collectDefinitionRefs(entry, prefix, names);
    }
  }
  return names;
}

function rewriteDefinitionRefs(value: unknown, externalRefPrefix: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteDefinitionRefs(entry, externalRefPrefix));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string" && entry.startsWith(externalRefPrefix)
        ? `${localDefinitionRefPrefix}${entry.slice(externalRefPrefix.length)}`
        : rewriteDefinitionRefs(entry, externalRefPrefix),
    ]),
  );
}

const dynamicToolCallParamsSchema = materializeCodexSchema(
  rawDynamicToolCallParamsSchema,
  rootExternalDefinitionRefPrefix,
);
const errorNotificationSchema = materializeCodexSchema(rawErrorNotificationSchema);
const modelListResponseSchema = materializeCodexSchema(rawModelListResponseSchema);
const threadResumeResponseSchema = materializeCodexSchema(rawThreadResumeResponseSchema);
const threadStartResponseSchema = materializeCodexSchema(rawThreadStartResponseSchema);
const turnCompletedNotificationSchema = materializeCodexSchema(rawTurnCompletedNotificationSchema);
const turnStartResponseSchema = materializeCodexSchema(rawTurnStartResponseSchema);

function compileCodexSchema<T>(schema: unknown): CodexValidator<T> {
  if (typeof schema !== "boolean" && !isRecord(schema)) {
    throw new TypeError("Generated Codex schema must be an object or boolean");
  }
  const validator = Compile(normalizeJsonSchemaForTypeBox(schema) as never) as TypeBoxValidator;
  return {
    check: (value): value is T => validator.Check(value),
    errors: (value) => [...validator.Errors(value)] as ValidationError[],
  };
}

function schemaTypeIncludes(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function readDefault(schema: unknown): unknown {
  if (!isRecord(schema) || !Object.hasOwn(schema, "default")) {
    return undefined;
  }
  return structuredClone(schema.default);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current = root;
  for (const segment of ref.slice(2).split("/").map(decodePointerSegment)) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function applySchemaDefaults(
  schema: unknown,
  value: unknown,
  root = schema,
  resolvingRefs = new Set<string>(),
): unknown {
  // Codex omits some fields that generated schemas default. Apply those defaults
  // before validation so callers get stable normalized protocol shapes.
  if (value === undefined) {
    const defaultValue = readDefault(schema);
    if (defaultValue !== undefined) {
      return defaultValue;
    }
  }
  if (!isRecord(schema)) {
    return value;
  }
  let nextValue = value;
  if (typeof schema.$ref === "string" && !resolvingRefs.has(schema.$ref)) {
    const target = resolveLocalRef(root, schema.$ref);
    if (target !== undefined) {
      resolvingRefs.add(schema.$ref);
      nextValue = applySchemaDefaults(target, nextValue, root, resolvingRefs);
      resolvingRefs.delete(schema.$ref);
    }
  }
  for (const key of ["allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        nextValue = applySchemaDefaults(branch, nextValue, root, resolvingRefs);
      }
    }
  }
  if (schemaTypeIncludes(schema, "object") && isRecord(nextValue) && isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      const currentValue = nextValue[key];
      const defaultedValue = applySchemaDefaults(propertySchema, currentValue, root, resolvingRefs);
      if (defaultedValue !== undefined && defaultedValue !== currentValue) {
        nextValue[key] = defaultedValue;
      }
    }
    if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(nextValue)) {
        if (Object.hasOwn(schema.properties, key)) {
          continue;
        }
        nextValue[key] = applySchemaDefaults(
          schema.additionalProperties,
          nextValue[key],
          root,
          resolvingRefs,
        );
      }
    }
  }
  if (schemaTypeIncludes(schema, "array") && Array.isArray(nextValue) && isRecord(schema.items)) {
    return nextValue.map((entry) => applySchemaDefaults(schema.items, entry, root, resolvingRefs));
  }
  return nextValue;
}

function normalizeWithDefaults(schema: unknown, value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  return applySchemaDefaults(schema, structuredClone(value));
}

const validateDynamicToolCallParams = compileCodexSchema<CodexDynamicToolCallParams>(
  dynamicToolCallParamsSchema,
);
const validateErrorNotification =
  compileCodexSchema<CodexErrorNotification>(errorNotificationSchema);
const validateModelListResponse =
  compileCodexSchema<CodexModelListResponse>(modelListResponseSchema);
const validateThreadResumeResponse = compileCodexSchema<CodexThreadResumeResponse>(
  threadResumeResponseSchema,
);
const validateThreadStartResponse =
  compileCodexSchema<CodexThreadStartResponse>(threadStartResponseSchema);
const validateTurnCompletedNotification = compileCodexSchema<CodexTurnCompletedNotification>(
  turnCompletedNotificationSchema,
);
const validateTurnStartResponse =
  compileCodexSchema<CodexTurnStartResponse>(turnStartResponseSchema);

/** Asserts and normalizes a Codex thread/start response. */
export function assertCodexThreadStartResponse(value: unknown): CodexThreadStartResponse {
  const normalized = normalizeWithDefaults(threadStartResponseSchema, value);
  return assertCodexShape(validateThreadStartResponse, normalized, "thread/start response");
}

/** Asserts and normalizes a Codex thread/fork response. */
export function assertCodexThreadForkResponse(value: unknown): CodexThreadForkResponse {
  const normalized = normalizeWithDefaults(threadStartResponseSchema, value);
  return assertCodexShape(validateThreadStartResponse, normalized, "thread/fork response");
}

/** Asserts and normalizes a Codex thread/resume response. */
export function assertCodexThreadResumeResponse(value: unknown): CodexThreadResumeResponse {
  const normalized = normalizeWithDefaults(threadResumeResponseSchema, value);
  return assertCodexShape(validateThreadResumeResponse, normalized, "thread/resume response");
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

/** Asserts and normalizes a Codex turn/start response. */
export function assertCodexTurnStartResponse(value: unknown): CodexTurnStartResponse {
  const normalized = normalizeWithDefaults(turnStartResponseSchema, value);
  return assertCodexShape(validateTurnStartResponse, normalized, "turn/start response");
}

/** Exact input echoes and attested managed-hook continuations cannot admit native capabilities. */
export function assertCodexPassiveTurnItems(
  items: readonly CodexThreadItem[],
  submittedInput: readonly CodexUserInput[],
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
      if (
        submittedInput.length > 0 &&
        content.length === submittedInput.length &&
        submittedInput.every((expected, index) => {
          const echoed = content[index];
          return (
            expected.type === "text" &&
            isJsonObject(echoed) &&
            echoed.type === "text" &&
            echoed.text === expected.text
          );
        })
      ) {
        promptEchoSeen = true;
        continue;
      }
    }
    throw new Error(`Codex ${taskLabel} returned unexpected native item: ${item.type}`);
  }
}

/** Reads Codex dynamic-tool call params, returning undefined for invalid payloads. */
export function readCodexDynamicToolCallParams(
  value: unknown,
): CodexDynamicToolCallParams | undefined {
  return readCodexShape(
    validateDynamicToolCallParams,
    normalizeWithDefaults(dynamicToolCallParamsSchema, value),
  );
}

/** Reads a Codex error notification payload if it matches the protocol schema. */
export function readCodexErrorNotification(value: unknown): CodexErrorNotification | undefined {
  return readCodexShape(
    validateErrorNotification,
    normalizeWithDefaults(errorNotificationSchema, value),
  );
}

/** Asserts and normalizes a Codex model/list response. */
export function assertCodexModelListResponse(value: unknown): CodexModelListResponse {
  return assertCodexShape(
    validateModelListResponse,
    normalizeWithDefaults(modelListResponseSchema, value),
    "model/list response",
  );
}

/** Reads a Codex turn/completed notification payload if it matches the protocol schema. */
export function readCodexTurnCompletedNotification(
  value: unknown,
): CodexTurnCompletedNotification | undefined {
  const notification = readCodexShape(
    validateTurnCompletedNotification,
    normalizeWithDefaults(turnCompletedNotificationSchema, value),
  );
  // Turn is shared with turn/start, but only terminal states belong in this notification.
  return notification?.turn.status === "inProgress" ? undefined : notification;
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
