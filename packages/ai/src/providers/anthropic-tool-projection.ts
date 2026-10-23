import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AnthropicOptions } from "../provider-options.js";
import { sortPromptCacheToolsByName } from "../utils/prompt-cache-stability.js";
import { SCHEMA_ARRAY_KEYS, SCHEMA_MAP_KEYS, SCHEMA_OBJECT_KEYS } from "./schema-walk.js";
import { inheritToolSchemaTruncation } from "./tool-schema-depth.js";
import {
  getPublishedRuntimeToolInputSchema,
  projectRuntimeToolInputSchema,
  publishRuntimeToolInputSchema,
} from "./tool-schema-json-projection.js";

type AnthropicToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
};

type AnthropicProjectedTool = {
  readonly originalName: string;
  readonly wireName: string;
  readonly description?: string;
  readonly inputSchema: AnthropicTool["input_schema"] & {
    readonly properties: Record<string, unknown>;
    readonly required: string[];
  };
};

export type AnthropicToolProjection = {
  readonly inputToolCount: number;
  readonly unavailableOriginalNames: ReadonlySet<string>;
  readonly tools: readonly AnthropicProjectedTool[];
};

type AnthropicParallelToolChoice = {
  readonly disable_parallel_tool_use?: boolean;
};

export type AnthropicProjectedToolChoice =
  | ({ readonly type: "auto" } & AnthropicParallelToolChoice)
  | ({ readonly type: "any" } & AnthropicParallelToolChoice)
  | { readonly type: "none" }
  | ({ readonly type: "tool"; readonly name: string } & AnthropicParallelToolChoice);

const CLAUDE_CODE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];
const CLAUDE_CODE_TOOL_LOOKUP = new Map(
  CLAUDE_CODE_TOOL_NAMES.map((name) => [name.toLowerCase(), name]),
);

/** Preserve Claude Code's canonical tool casing for subscription OAuth requests. */
export function toClaudeCodeToolName(name: string): string {
  return CLAUDE_CODE_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;
}

/** Anthropic rejects forced tools while extended thinking is enabled. */
export function normalizeAnthropicToolChoice(
  thinkingEnabled: boolean,
  toolChoice: NonNullable<AnthropicOptions["toolChoice"]>,
): AnthropicProjectedToolChoice {
  if (
    thinkingEnabled &&
    (toolChoice === "any" || (typeof toolChoice === "object" && toolChoice.type === "tool"))
  ) {
    return { type: "auto" };
  }
  return typeof toolChoice === "string" ? { type: toolChoice } : toolChoice;
}

/** Anthropic tool identifiers accept only ASCII word characters and dashes. */
export function normalizeAnthropicToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function isProviderSupportedViolation(violation: string): boolean {
  return violation.endsWith(".$dynamicRef") || violation.endsWith(".$dynamicAnchor");
}

/** Normalize the detached JSON projection and report tuple changes to enclosing schemas. */
function normalizeAnthropicJsonSchema(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }

  let changed = false;
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "additionalItems" && SCHEMA_OBJECT_KEYS.has(key) && !Array.isArray(value)) {
      changed = normalizeAnthropicJsonSchema(value) || changed;
      continue;
    }
    if (key !== "items" && SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      for (const entry of value) {
        changed = normalizeAnthropicJsonSchema(entry) || changed;
      }
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      for (const entry of Object.values(value)) {
        changed = normalizeAnthropicJsonSchema(entry) || changed;
      }
    }
  }

  if (Array.isArray(schema.items)) {
    for (const entry of schema.items) {
      normalizeAnthropicJsonSchema(entry);
    }
    schema.prefixItems = schema.items;
    const additionalItems = schema.additionalItems;
    if (typeof additionalItems === "boolean" || isRecord(additionalItems)) {
      normalizeAnthropicJsonSchema(additionalItems);
      schema.items = additionalItems;
    } else {
      delete schema.items;
    }
    delete schema.additionalItems;
    changed = true;
  }

  if (changed) {
    // Converted tuples use 2020-12 syntax, including inside referenced schema resources.
    delete schema.$schema;
  }
  return changed;
}

const publishedAnthropicSchemas = new WeakMap<
  object,
  AnthropicProjectedTool["inputSchema"] | null
>();

/** Prepare a detached JSON projection for Anthropic's tuple dialect. */
export function prepareAnthropicInputSchema(
  schema: Record<string, unknown>,
): AnthropicProjectedTool["inputSchema"] | null {
  const published = getPublishedRuntimeToolInputSchema(schema);
  const cached = published ? publishedAnthropicSchemas.get(schema) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  // Tuple normalization mutates its input; published JSON stays detached from that work.
  const normalized: Record<string, unknown> = published ? JSON.parse(published.json) : schema;
  normalizeAnthropicJsonSchema(normalized);
  const properties = normalized.properties;
  const required = normalized.required;
  if (
    (properties !== undefined && properties !== null && !isRecord(properties)) ||
    (required !== undefined &&
      required !== null &&
      (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")))
  ) {
    if (published) {
      publishedAnthropicSchemas.set(schema, null);
    }
    return null;
  }
  const inputSchema: AnthropicProjectedTool["inputSchema"] = {
    ...normalized,
    type: "object",
    properties: (properties ?? {}) as Record<string, unknown>,
    required: (required ?? []) as string[],
  };
  inheritToolSchemaTruncation(schema, inputSchema);
  if (!published) {
    return inputSchema;
  }
  const projection = publishRuntimeToolInputSchema(inputSchema);
  // SAFETY: Publication preserves the validated object root, properties map, and string required entries.
  const result = projection.schema as AnthropicProjectedTool["inputSchema"];
  publishedAnthropicSchemas.set(schema, result);
  return result;
}

/** Snapshots direct/custom tool descriptors before Anthropic payload construction. */
export function projectAnthropicTools(
  tools: readonly AnthropicToolDescriptor[],
  toWireName: (name: string) => string,
): AnthropicToolProjection {
  const projectedTools: AnthropicProjectedTool[] = [];
  const originalNameByWireName = new Map<string, string>();
  const unavailableOriginalNames = new Set<string>();
  for (const tool of tools) {
    const name = tool.name;
    if (!name) {
      continue;
    }
    const schemaProjection = projectRuntimeToolInputSchema(
      tool.parameters,
      `${name}.parameters`,
      name,
    );
    if (
      !isRecord(schemaProjection.schema) ||
      schemaProjection.violations.some((violation) => !isProviderSupportedViolation(violation))
    ) {
      unavailableOriginalNames.add(name);
      continue;
    }
    const inputSchema = prepareAnthropicInputSchema(schemaProjection.schema);
    if (!inputSchema) {
      unavailableOriginalNames.add(name);
      continue;
    }
    const descriptionValue = tool.description;
    const description = typeof descriptionValue === "string" ? descriptionValue : undefined;
    const projectedTool: AnthropicProjectedTool = {
      originalName: name,
      wireName: toWireName(name),
      ...(description ? { description } : {}),
      inputSchema,
    };
    const conflictingName = originalNameByWireName.get(projectedTool.wireName);
    if (conflictingName !== undefined && conflictingName !== projectedTool.originalName) {
      throw new Error(
        `Anthropic tool names "${conflictingName}" and "${projectedTool.originalName}" both map to "${projectedTool.wireName}"`,
      );
    }
    originalNameByWireName.set(projectedTool.wireName, projectedTool.originalName);
    projectedTools.push(projectedTool);
  }
  return {
    inputToolCount: tools.length,
    unavailableOriginalNames,
    // Anthropic caches through the last wire tool, so discovery order must not
    // move the cache breakpoint or change otherwise identical request bytes.
    tools: sortPromptCacheToolsByName(projectedTools),
  };
}

/** Keeps forced Anthropic tool choices aligned with the projected wire names. */
export function reconcileAnthropicToolChoice(
  choice: AnthropicProjectedToolChoice,
  projection: AnthropicToolProjection,
): AnthropicProjectedToolChoice | undefined {
  if (projection.inputToolCount === 0) {
    return choice;
  }
  if (choice.type === "tool") {
    const requestedName = choice.name;
    const matchedTool =
      projection.tools.find((tool) => tool.originalName === requestedName) ??
      (projection.unavailableOriginalNames.has(requestedName)
        ? undefined
        : projection.tools.find((tool) => tool.wireName === requestedName));
    if (!matchedTool) {
      throw new Error(
        `Anthropic tool_choice requested unavailable tool "${requestedName}" after schema conversion`,
      );
    }
    return { ...choice, name: matchedTool.wireName };
  }
  if (projection.tools.length === 0) {
    if (choice.type === "auto") {
      return undefined;
    }
    if (choice.type === "any") {
      throw new Error(
        "Anthropic tool_choice requires a tool, but no tools survived schema conversion",
      );
    }
  }
  return choice;
}

/** Maps Claude Code wire names without trusting every direct/custom descriptor. */
export function resolveOriginalAnthropicToolName(
  name: string,
  projection: AnthropicToolProjection | undefined,
): string {
  return projection?.tools.find((tool) => tool.wireName === name)?.originalName ?? name;
}
