import { embeddedAgentLog, type EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  mapExecDecisionToOutcome,
  requestPluginApproval,
  type AppServerApprovalOutcome,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

type ApprovalPropertyContext = {
  name: string;
  schema: JsonObject;
  required: boolean;
};

type BridgeableApprovalElicitation = {
  title: string;
  description: string;
  requestedSchema: JsonObject;
  meta: JsonObject;
};

export async function handleCodexAppServerElicitationRequest(params: {
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (!matchesCurrentTurn(requestParams, params.threadId, params.turnId)) {
    return undefined;
  }
  const approvalPrompt = readBridgeableApprovalElicitation(requestParams);
  if (!approvalPrompt) {
    return undefined;
  }

  const outcome = await requestPluginApprovalOutcome({
    paramsForRun: params.paramsForRun,
    title: approvalPrompt.title,
    description: approvalPrompt.description,
    signal: params.signal,
  });
  return buildElicitationResponse(approvalPrompt.requestedSchema, approvalPrompt.meta, outcome);
}

function matchesCurrentTurn(
  requestParams: JsonObject | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!requestParams) {
    return false;
  }
  const requestThreadId = readString(requestParams, "threadId");
  if (requestThreadId !== threadId) {
    return false;
  }
  const rawTurnId = requestParams.turnId;
  if (rawTurnId !== null && rawTurnId !== undefined && rawTurnId !== turnId) {
    return false;
  }
  return true;
}

function readBridgeableApprovalElicitation(
  requestParams: JsonObject | undefined,
): BridgeableApprovalElicitation | undefined {
  if (
    !requestParams ||
    readString(requestParams, "mode") !== "form" ||
    !isJsonObject(requestParams._meta) ||
    requestParams._meta.codex_approval_kind !== "mcp_tool_call" ||
    !isJsonObject(requestParams.requestedSchema)
  ) {
    return undefined;
  }

  const requestedSchema = requestParams.requestedSchema;
  if (
    readString(requestedSchema, "type") !== "object" ||
    !isJsonObject(requestedSchema.properties) ||
    Object.keys(requestedSchema.properties).length === 0
  ) {
    return undefined;
  }

  const title = readString(requestParams, "message") ?? "Codex MCP tool approval";
  const propertyLines = Object.entries(requestedSchema.properties)
    .map(([name, value]) => {
      const schema = isJsonObject(value) ? value : undefined;
      if (!schema) {
        return undefined;
      }
      const propTitle = readString(schema, "title") ?? name;
      const description = readString(schema, "description");
      return description ? `- ${propTitle}: ${description}` : `- ${propTitle}`;
    })
    .filter((line): line is string => Boolean(line));

  return {
    title,
    description: [title, propertyLines.length > 0 ? ["Fields:", ...propertyLines].join("\n") : ""]
      .filter(Boolean)
      .join("\n\n"),
    requestedSchema,
    meta: requestParams._meta,
  };
}

async function requestPluginApprovalOutcome(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  signal?: AbortSignal;
}): Promise<AppServerApprovalOutcome> {
  try {
    const requestResult = await requestPluginApproval({
      paramsForRun: params.paramsForRun,
      title: params.title,
      description: params.description,
      severity: "warning",
      toolName: "codex_mcp_tool_approval",
    });

    const approvalId = requestResult?.id;
    if (!approvalId) {
      return "unavailable";
    }

    const decision = Object.prototype.hasOwnProperty.call(requestResult, "decision")
      ? requestResult.decision
      : await waitForPluginApprovalDecision({ approvalId, signal: params.signal });
    return mapExecDecisionToOutcome(decision);
  } catch {
    return params.signal?.aborted ? "cancelled" : "denied";
  }
}

function buildElicitationResponse(
  requestedSchema: JsonObject,
  meta: JsonObject,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  if (outcome === "cancelled") {
    return { action: "cancel", content: null, _meta: null };
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return { action: "decline", content: null, _meta: null };
  }

  const content = buildAcceptedContent(requestedSchema, meta, outcome);
  if (!content) {
    embeddedAgentLog.warn("codex MCP approval elicitation approved without a mappable response", {
      approvalKind: meta.codex_approval_kind,
      fields: Object.keys(requestedSchema.properties ?? {}),
      outcome,
    });
    return { action: "decline", content: null, _meta: null };
  }
  return { action: "accept", content, _meta: null };
}

function buildAcceptedContent(
  requestedSchema: JsonObject,
  meta: JsonObject,
  outcome: AppServerApprovalOutcome,
): JsonObject | undefined {
  const properties = isJsonObject(requestedSchema.properties)
    ? requestedSchema.properties
    : undefined;
  if (!properties) {
    return undefined;
  }
  const required = Array.isArray(requestedSchema.required)
    ? new Set(
        requestedSchema.required.filter((entry): entry is string => typeof entry === "string"),
      )
    : new Set<string>();
  const content: JsonObject = {};
  let sawApprovalField = false;

  for (const [name, value] of Object.entries(properties)) {
    const schema = isJsonObject(value) ? value : undefined;
    if (!schema) {
      continue;
    }
    const property = { name, schema, required: required.has(name) };
    const next =
      readApprovalFieldValue(property, outcome) ??
      readPersistFieldValue(property, meta, outcome) ??
      readFallbackFieldValue(property, outcome);

    if (next === undefined) {
      if (isApprovalField(property)) {
        sawApprovalField = true;
      }
      if (property.required) {
        return undefined;
      }
      continue;
    }

    if (isApprovalField(property)) {
      sawApprovalField = true;
    }
    content[name] = next;
  }

  return sawApprovalField ? content : undefined;
}

function readApprovalFieldValue(
  property: ApprovalPropertyContext,
  outcome: AppServerApprovalOutcome,
): JsonValue | undefined {
  if (!isApprovalField(property)) {
    return undefined;
  }
  const type = readString(property.schema, "type");
  if (type === "boolean") {
    return true;
  }
  const options = readEnumOptions(property.schema);
  if (options.length === 0) {
    return undefined;
  }

  const sessionChoice = options.find((option) => isSessionApprovalOption(option));
  const acceptChoice = options.find((option) => isPositiveApprovalOption(option));
  if (outcome === "approved-session") {
    return sessionChoice?.value ?? acceptChoice?.value;
  }
  return acceptChoice?.value ?? sessionChoice?.value;
}

function readPersistFieldValue(
  property: ApprovalPropertyContext,
  meta: JsonObject,
  outcome: AppServerApprovalOutcome,
): JsonValue | undefined {
  if (!isPersistField(property) || outcome !== "approved-session") {
    return undefined;
  }
  const persistHints = readPersistHints(meta);
  const options = readEnumOptions(property.schema);
  if (options.length === 0) {
    return undefined;
  }
  for (const preferred of persistHints) {
    const match = options.find(
      (option) => option.value === preferred || option.label === preferred,
    );
    if (match) {
      return match.value;
    }
  }
  return options.find((option) => option.value === "session" || option.label === "session")?.value;
}

function readDefaultValue(schema: JsonObject): JsonValue | undefined {
  return schema.default as JsonValue | undefined;
}

function readFallbackFieldValue(
  property: ApprovalPropertyContext,
  outcome: AppServerApprovalOutcome,
): JsonValue | undefined {
  if (outcome === "approved-once" && isPersistField(property)) {
    return undefined;
  }
  return readDefaultValue(property.schema);
}

function isApprovalField(property: ApprovalPropertyContext): boolean {
  const haystack = propertyText(property).toLowerCase();
  return /\b(approve|approval|allow|accept|decision)\b/.test(haystack);
}

function isPersistField(property: ApprovalPropertyContext): boolean {
  const haystack = propertyText(property).toLowerCase();
  return /\b(persist|session|always|scope)\b/.test(haystack);
}

function propertyText(property: ApprovalPropertyContext): string {
  return [
    property.name,
    readString(property.schema, "title"),
    readString(property.schema, "description"),
  ]
    .filter(Boolean)
    .join(" ");
}

function readPersistHints(meta: JsonObject): string[] {
  const raw = meta.persist;
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  return ["session", "always"];
}

function readEnumOptions(schema: JsonObject): Array<{ value: string; label: string }> {
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((entry): entry is string => typeof entry === "string");
    const labels = Array.isArray(schema.enumNames)
      ? schema.enumNames.filter((entry): entry is string => typeof entry === "string")
      : [];
    return values.map((value, index) => ({ value, label: labels[index] ?? value }));
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((entry) => {
        const option = isJsonObject(entry) ? entry : undefined;
        const value = readString(option, "const");
        if (!value) {
          return undefined;
        }
        return { value, label: readString(option, "title") ?? value };
      })
      .filter((entry): entry is { value: string; label: string } => Boolean(entry));
  }
  return [];
}

function isPositiveApprovalOption(option: { value: string; label: string }): boolean {
  const haystack = `${option.value} ${option.label}`.toLowerCase();
  return /\b(allow|approve|accept|yes|continue|proceed|true)\b/.test(haystack);
}

function isSessionApprovalOption(option: { value: string; label: string }): boolean {
  const haystack = `${option.value} ${option.label}`.toLowerCase();
  return (
    /\b(session|always|persistent)\b/.test(haystack) && /\b(allow|approve|accept)\b/.test(haystack)
  );
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
