import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple, validateToolArguments, type AssistantMessage } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "../../pi-tools.types.js";
import { stableStringify } from "../../stable-stringify.js";
import { wrapStreamObjectEvents } from "./stream-wrapper.js";

const DEFAULT_REPEATED_SCHEMA_FAILURE_THRESHOLD = 3;
const ARGUMENT_SUMMARY_MAX_CHARS = 512;

type ToolSchemaValidationGuardState = {
  lastSignature?: string;
  consecutiveCount: number;
};

type ValidationIssueSummary = {
  path: string;
  message: string;
};

type ToolSchemaValidationFailure = {
  signature: string;
  toolName: string;
  toolCallId?: string;
  missingFields: string[];
  validationIssues: ValidationIssueSummary[];
  receivedArgumentsSummary: string;
  provider?: string;
  model?: string;
  responseId?: string;
};

export class RepeatedToolSchemaValidationError extends Error {
  readonly diagnostic: ToolSchemaValidationFailure & { consecutiveCount: number };

  constructor(failure: ToolSchemaValidationFailure, consecutiveCount: number) {
    const missingSummary =
      failure.missingFields.length > 0 ? failure.missingFields.join(", ") : "none detected";
    const validationSummary =
      failure.validationIssues.length > 0
        ? failure.validationIssues
            .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
            .join("; ")
        : "validation failed";
    super(
      `Aborting run after ${consecutiveCount} consecutive identical tool schema validation ` +
        `failures for tool "${failure.toolName}". ` +
        `Missing fields: ${missingSummary}. ` +
        `Validation: ${validationSummary}. ` +
        `Received arguments: ${failure.receivedArgumentsSummary}. ` +
        `Provider/model: ${failure.provider ?? "unknown"}/${failure.model ?? "unknown"}. ` +
        `Response id: ${failure.responseId ?? "unavailable"}.`,
    );
    this.name = "RepeatedToolSchemaValidationError";
    this.diagnostic = { ...failure, consecutiveCount };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeArguments(value: unknown): string {
  const text = stableStringify(value);
  return text.length > ARGUMENT_SUMMARY_MAX_CHARS
    ? `${text.slice(0, ARGUMENT_SUMMARY_MAX_CHARS)}…`
    : text;
}

function extractToolCallsFromMessage(message: unknown): Array<{
  id?: string;
  name: string;
  arguments: unknown;
}> {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  const calls: Array<{ id?: string; name: string; arguments: unknown }> = [];
  for (const block of message.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type !== "toolCall" && block.type !== "toolUse" && block.type !== "functionCall") {
      continue;
    }
    const name = readString(block.name);
    if (!name) {
      continue;
    }
    calls.push({
      id: readString(block.id),
      name,
      arguments: block.arguments ?? block.input,
    });
  }
  return calls;
}

function collectTopLevelMissingRequiredFields(tool: AnyAgentTool, args: unknown): string[] {
  const seen = new Set<string>();
  const visitSchema = (schema: unknown) => {
    if (!isRecord(schema)) {
      return;
    }
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (typeof field === "string" && (!isRecord(args) || !(field in args))) {
          seen.add(field);
        }
      }
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const entries = schema[key];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          visitSchema(entry);
        }
      }
    }
  };
  visitSchema(tool.parameters);
  return [...seen].toSorted();
}

function issueFromRecord(record: Record<string, unknown>): ValidationIssueSummary | undefined {
  const rawPath =
    record.path ?? record.instancePath ?? record.schemaPath ?? record.dataPath ?? record.field;
  const message = readString(record.message) ?? readString(record.error) ?? readString(record.code);
  if (!message) {
    return undefined;
  }
  let path = "";
  if (typeof rawPath === "string") {
    path = rawPath;
  } else if (Array.isArray(rawPath)) {
    path = rawPath.map((part) => String(part)).join(".");
  }
  return { path, message };
}

function parseValidationIssuesFromMessage(message: string): ValidationIssueSummary[] {
  const issues: ValidationIssueSummary[] = [];
  for (const line of message.split("\n")) {
    const match = /^\s*-\s+([^:]+):\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    issues.push({ path: match[1]?.trim() ?? "", message: match[2]?.trim() ?? "" });
  }
  return issues.filter((issue) => issue.message);
}

function collectValidationIssues(error: unknown): ValidationIssueSummary[] {
  const issues: ValidationIssueSummary[] = [];
  const maybeErrorRecord = isRecord(error) ? error : undefined;
  const candidateLists = [
    maybeErrorRecord?.errors,
    maybeErrorRecord?.issues,
    maybeErrorRecord?.details,
    maybeErrorRecord?.cause,
  ];
  for (const candidate of candidateLists) {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (isRecord(entry)) {
          const issue = issueFromRecord(entry);
          if (issue) {
            issues.push(issue);
          }
        }
      }
    }
  }
  if (issues.length === 0) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(...parseValidationIssuesFromMessage(message));
    if (issues.length === 0) {
      issues.push({ path: "", message });
    }
  }
  return issues.toSorted((a, b) =>
    `${a.path}:${a.message}`.localeCompare(`${b.path}:${b.message}`),
  );
}

function buildValidationFailure(params: {
  tool: AnyAgentTool;
  toolCall: { id?: string; name: string; arguments: unknown };
  error: unknown;
  message: unknown;
  model: { provider?: unknown; id?: unknown };
}): ToolSchemaValidationFailure {
  const provider =
    readString((params.message as { provider?: unknown } | undefined)?.provider) ??
    readString(params.model.provider);
  const model =
    readString((params.message as { model?: unknown } | undefined)?.model) ??
    readString(params.model.id);
  const responseId = readString(
    (params.message as { responseId?: unknown } | undefined)?.responseId,
  );
  const missingFields = collectTopLevelMissingRequiredFields(
    params.tool,
    params.toolCall.arguments,
  );
  const validationIssues = collectValidationIssues(params.error);
  const receivedArgumentsSummary = summarizeArguments(params.toolCall.arguments);
  const signature = stableStringify({
    toolName: params.toolCall.name,
    missingFields,
    validationIssues,
    receivedArguments: params.toolCall.arguments,
  });
  return {
    signature,
    toolName: params.toolCall.name,
    ...(params.toolCall.id ? { toolCallId: params.toolCall.id } : {}),
    missingFields,
    validationIssues,
    receivedArgumentsSummary,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(responseId ? { responseId } : {}),
  };
}

function validateAssistantToolCalls(params: {
  message: unknown;
  toolsByName: Map<string, AnyAgentTool>;
  state: ToolSchemaValidationGuardState;
  threshold: number;
  model: { provider?: unknown; id?: unknown };
}): void {
  const toolCalls = extractToolCallsFromMessage(params.message);
  if (toolCalls.length === 0) {
    params.state.lastSignature = undefined;
    params.state.consecutiveCount = 0;
    return;
  }

  for (const toolCall of toolCalls) {
    const tool = params.toolsByName.get(toolCall.name);
    if (!tool) {
      params.state.lastSignature = undefined;
      params.state.consecutiveCount = 0;
      continue;
    }
    try {
      validateToolArguments(tool, {
        type: "toolCall",
        id: toolCall.id ?? `${toolCall.name}-schema-validation-guard`,
        name: toolCall.name,
        arguments: toolCall.arguments as never,
      });
      params.state.lastSignature = undefined;
      params.state.consecutiveCount = 0;
    } catch (error) {
      const failure = buildValidationFailure({
        tool,
        toolCall,
        error,
        message: params.message,
        model: params.model,
      });
      if (params.state.lastSignature === failure.signature) {
        params.state.consecutiveCount += 1;
      } else {
        params.state.lastSignature = failure.signature;
        params.state.consecutiveCount = 1;
      }
      if (params.state.consecutiveCount >= params.threshold) {
        throw new RepeatedToolSchemaValidationError(failure, params.state.consecutiveCount);
      }
    }
  }
}

function wrapStreamToolSchemaValidationGuard(
  stream: ReturnType<typeof streamSimple>,
  params: {
    toolsByName: Map<string, AnyAgentTool>;
    state: ToolSchemaValidationGuardState;
    threshold: number;
    model: { provider?: unknown; id?: unknown };
  },
): ReturnType<typeof streamSimple> {
  const countedMessages = new WeakSet<object>();
  const validateOnce = (message: unknown) => {
    if (!isRecord(message)) {
      return;
    }
    if (countedMessages.has(message)) {
      return;
    }
    countedMessages.add(message);
    validateAssistantToolCalls({ ...params, message });
  };

  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    validateOnce(message);
    return message as AssistantMessage;
  };

  wrapStreamObjectEvents(stream, (event) => {
    // Count only finalized assistant messages. Partial stream snapshots can repeat
    // the same bad call many times before the model has completed one turn.
    if (event.type === "done") {
      validateOnce(event.message);
    }
  });

  return stream;
}

export function wrapStreamFnAbortRepeatedToolSchemaValidationFailures(
  baseFn: StreamFn,
  tools: AnyAgentTool[],
  options?: { threshold?: number },
): StreamFn {
  const state: ToolSchemaValidationGuardState = { consecutiveCount: 0 };
  const toolsByName = new Map<string, AnyAgentTool>();
  for (const tool of tools) {
    if (typeof tool.name === "string" && tool.name.trim()) {
      toolsByName.set(tool.name, tool);
    }
  }
  const threshold = Math.max(1, options?.threshold ?? DEFAULT_REPEATED_SCHEMA_FAILURE_THRESHOLD);
  return (model, context, streamOptions) => {
    const maybeStream = baseFn(model, context, streamOptions);
    const guardParams = { toolsByName, state, threshold, model };
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamToolSchemaValidationGuard(stream, guardParams),
      );
    }
    return wrapStreamToolSchemaValidationGuard(maybeStream, guardParams);
  };
}
