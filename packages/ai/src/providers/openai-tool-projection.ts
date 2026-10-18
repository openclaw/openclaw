import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import {
  prepareRuntimeToolInputSchema,
  projectRuntimeToolInputSchema,
} from "./tool-schema-json-projection.js";
import type { PreparedToolSchemaNormalization } from "./tool-schema-normalization-cache.js";

type OpenAIToolDescriptor = {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly parameters: unknown;
};

type OpenAIProjectedTool = {
  readonly toolIndex: number;
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
};

type OpenAIToolProjectionDiagnostic = {
  readonly toolIndex: number;
  readonly toolName?: string;
  readonly violations: readonly string[];
};

export type OpenAIToolProjection = {
  readonly inputToolCount: number;
  readonly tools: readonly OpenAIProjectedTool[];
  readonly diagnostics: readonly OpenAIToolProjectionDiagnostic[];
};

type OpenAIResponsesToolChoice = ResponseCreateParamsStreaming["tool_choice"];
type OpenAIResponsesAllowedToolChoice = Extract<
  OpenAIResponsesToolChoice,
  { type: "allowed_tools" }
>;
type OpenAICompletionsSdkToolChoice =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming["tool_choice"];
type OpenAICompletionsAllowedToolChoice = Extract<
  OpenAICompletionsSdkToolChoice,
  { type: "allowed_tools" }
>;
export type OpenAICompletionsToolChoice = Exclude<
  OpenAICompletionsSdkToolChoice,
  { type: "custom" }
>;

function unreadableToolDiagnostic(toolIndex: number): OpenAIToolProjectionDiagnostic {
  return {
    toolIndex,
    violations: [`tool[${toolIndex}] is unreadable`],
  };
}

/** Snapshots direct/custom tool descriptors before OpenAI payload construction. */
export function projectOpenAITools(tools: readonly OpenAIToolDescriptor[]): OpenAIToolProjection {
  return projectOpenAIToolDescriptors(tools);
}

/** Package-private facts are consumed before the projection or payload can escape. */
export function prepareOpenAITools(tools: readonly OpenAIToolDescriptor[]) {
  const schemas = new Map<Record<string, unknown>, PreparedToolSchemaNormalization>();
  return { projection: projectOpenAIToolDescriptors(tools, schemas), schemas };
}

function projectOpenAIToolDescriptors(
  tools: readonly OpenAIToolDescriptor[],
  schemas?: Map<Record<string, unknown>, PreparedToolSchemaNormalization>,
): OpenAIToolProjection {
  let inputToolCount: number;
  try {
    inputToolCount = tools.length;
  } catch {
    return {
      inputToolCount: 0,
      tools: [],
      diagnostics: [unreadableToolDiagnostic(0)],
    };
  }

  const projectedTools: OpenAIProjectedTool[] = [];
  const diagnostics: OpenAIToolProjectionDiagnostic[] = [];
  for (let toolIndex = 0; toolIndex < inputToolCount; toolIndex += 1) {
    let tool: OpenAIToolDescriptor;
    let name: string | undefined;
    let parameters: unknown;
    let readPath = `tool[${toolIndex}]`;
    try {
      const candidate = tools[toolIndex];
      if (!candidate) {
        diagnostics.push(unreadableToolDiagnostic(toolIndex));
        continue;
      }
      tool = candidate;
      readPath += ".name";
      const nameValue = tool.name;
      if (typeof nameValue !== "string" || !nameValue) {
        diagnostics.push({ toolIndex, violations: [`${readPath} is empty`] });
        continue;
      }
      name = nameValue;
      readPath = `${name}.parameters`;
      parameters = tool.parameters;
    } catch {
      diagnostics.push({
        toolIndex,
        ...(name ? { toolName: name } : {}),
        violations: [`${readPath} is unreadable`],
      });
      continue;
    }
    const prepared = schemas
      ? prepareRuntimeToolInputSchema(parameters ?? {}, `${name}.parameters`, name)
      : undefined;
    const schemaProjection =
      prepared?.projection ??
      projectRuntimeToolInputSchema(parameters ?? {}, `${name}.parameters`, name);
    if (!isRecord(schemaProjection.schema) || schemaProjection.violations.length > 0) {
      diagnostics.push({
        toolIndex,
        toolName: name,
        violations:
          schemaProjection.violations.length > 0
            ? schemaProjection.violations
            : [`${name}.parameters must be a JSON object schema`],
      });
      continue;
    }
    if (prepared?.normalization) {
      schemas?.set(schemaProjection.schema, prepared.normalization);
    }

    let descriptionValue: unknown;
    try {
      descriptionValue = tool.description;
    } catch {
      // Description is optional; preserve the usable function schema.
    }
    const description = typeof descriptionValue === "string" ? descriptionValue : undefined;
    projectedTools.push({
      toolIndex,
      name,
      ...(description !== undefined ? { description } : {}),
      parameters: schemaProjection.schema,
    });
  }

  return {
    inputToolCount,
    tools: projectedTools,
    diagnostics,
  };
}

type ToolChoice = OpenAIResponsesToolChoice | OpenAICompletionsSdkToolChoice;

function reconcileToolChoice(
  choice: OpenAIResponsesToolChoice,
  projection: OpenAIToolProjection,
  responses: true,
): OpenAIResponsesToolChoice | undefined;
function reconcileToolChoice(
  choice: OpenAICompletionsSdkToolChoice,
  projection: OpenAIToolProjection,
  responses: false,
): OpenAICompletionsSdkToolChoice | undefined;
function reconcileToolChoice(
  choice: ToolChoice,
  projection: OpenAIToolProjection,
  responses: boolean,
): ToolChoice | undefined {
  const label = responses ? "OpenAI Responses" : "OpenAI Chat Completions";
  if (choice === "auto") {
    return projection.tools.length > 0 ? choice : undefined;
  }
  if (choice === "required") {
    if (projection.tools.length === 0) {
      throw new Error(
        `${label} tool_choice requires a tool, but no tools survived schema conversion`,
      );
    }
    return choice;
  }
  if (choice === "none" || !isRecord(choice)) {
    return choice;
  }
  const choiceType = choice.type;
  if (!responses && choiceType === "custom") {
    throw new Error(
      "OpenAI Chat Completions custom tool_choice is unsupported because this adapter emits function tools only",
    );
  }
  if (choiceType === "function") {
    const functionChoice = responses ? choice : choice.function;
    const functionName = isRecord(functionChoice) ? functionChoice.name : undefined;
    if (typeof functionName !== "string") {
      return choice;
    }
    if (!projection.tools.some((tool) => tool.name === functionName)) {
      throw new Error(
        `${label} tool_choice requested unavailable tool "${functionName}" after schema conversion`,
      );
    }
    return responses
      ? { type: "function", name: functionName }
      : { type: "function", function: { name: functionName } };
  }
  if (choiceType !== "allowed_tools") {
    return choice;
  }

  const allowedConfig = responses ? choice : choice.allowed_tools;
  if (!isRecord(allowedConfig)) {
    return choice;
  }
  const { mode, tools } = allowedConfig;
  if ((mode !== "auto" && mode !== "required") || !Array.isArray(tools)) {
    return choice;
  }
  const responseTools: OpenAIResponsesAllowedToolChoice["tools"] = [];
  const completionTools: OpenAICompletionsAllowedToolChoice["allowed_tools"]["tools"] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || tool.type !== "function") {
      if (responses) {
        responseTools.push(tool);
      }
      continue;
    }
    const functionChoice = responses ? tool : tool.function;
    const functionName = isRecord(functionChoice) ? functionChoice.name : undefined;
    if (
      typeof functionName === "string" &&
      projection.tools.some((projectedTool) => projectedTool.name === functionName)
    ) {
      if (responses) {
        responseTools.push({ type: "function", name: functionName });
      } else {
        completionTools.push({ type: "function", function: { name: functionName } });
      }
    }
  }
  if (responseTools.length === 0 && completionTools.length === 0) {
    if (mode === "auto") {
      return "none";
    }
    throw new Error(
      `${label} tool_choice requires a tool, but no allowed tools survived schema conversion`,
    );
  }
  return responses
    ? { type: "allowed_tools", mode, tools: responseTools }
    : { type: "allowed_tools", allowed_tools: { mode, tools: completionTools } };
}

/** Keeps Responses tool choices aligned with surviving function schemas. */
export function reconcileOpenAIResponsesToolChoice(
  choice: OpenAIResponsesToolChoice,
  projection: OpenAIToolProjection,
): OpenAIResponsesToolChoice | undefined {
  return reconcileToolChoice(choice, projection, true);
}

/** Keeps Chat Completions tool choices aligned with surviving function schemas. */
export function reconcileOpenAICompletionsToolChoice(
  choice: OpenAICompletionsSdkToolChoice,
  projection: OpenAIToolProjection,
): OpenAICompletionsSdkToolChoice | undefined {
  return reconcileToolChoice(choice, projection, false);
}

/** Re-expresses an object Chat Completions tool choice in the Responses wire shape. */
export function toOpenAIResponsesToolChoice(
  choice: Exclude<NonNullable<OpenAICompletionsToolChoice>, string>,
): OpenAIResponsesToolChoice {
  if (choice.type === "function") {
    return { type: "function", name: choice.function.name };
  }
  return {
    type: "allowed_tools",
    mode: choice.allowed_tools.mode,
    tools: choice.allowed_tools.tools.map((tool) =>
      tool.type === "function" && isRecord(tool.function) && typeof tool.function.name === "string"
        ? { type: "function", name: tool.function.name }
        : tool,
    ),
  };
}
