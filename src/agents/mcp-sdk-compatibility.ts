import { isDeepStrictEqual } from "node:util";
import type {
  CallToolResult,
  GetPromptResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  StandardSchemaV1,
} from "@modelcontextprotocol/client";
import {
  CallToolResultSchema as V2CallToolResultSchema,
  GetPromptResultSchema as V2GetPromptResultSchema,
  ListResourceTemplatesResultSchema as V2ListResourceTemplatesResultSchema,
  ListToolsResultSchema as V2ListToolsResultSchema,
} from "@modelcontextprotocol/core";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { z } from "zod";

/** The published plugin SDK retains its v1 result shapes for one release window. */
export class McpSdkCompatibilityError extends Error {
  readonly code = "MCP_SDK_RESULT_UNREPRESENTABLE";

  constructor(readonly method: string) {
    super(`MCP ${method} result cannot be represented losslessly by the current plugin SDK`);
    this.name = "McpSdkCompatibilityError";
  }
}

function preservesWireFields(wire: unknown, parsed: unknown): boolean {
  if (Array.isArray(wire)) {
    return (
      Array.isArray(parsed) &&
      wire.length === parsed.length &&
      wire.every((value, index) => preservesWireFields(value, parsed[index]))
    );
  }
  if (isRecord(wire)) {
    return (
      isRecord(parsed) &&
      Object.entries(wire).every(
        ([key, value]) => Object.hasOwn(parsed, key) && preservesWireFields(value, parsed[key]),
      )
    );
  }
  return Object.is(wire, parsed);
}

function losslessWireResultSchema<T>(
  method: string,
  schema: z.ZodType<T>,
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "openclaw",
      validate(wire: unknown) {
        const parsed = schema.safeParse(wire);
        if (!parsed.success) {
          return { issues: parsed.error.issues };
        }
        // Permit SDK defaults, but reject fields it would remove before the v1 boundary sees them.
        if (!preservesWireFields(wire, parsed.data)) {
          throw new McpSdkCompatibilityError(method);
        }
        return { value: parsed.data };
      },
    },
  };
}

export const mcpCallToolResultSchema = losslessWireResultSchema(
  "tools/call",
  V2CallToolResultSchema,
);
export const mcpListToolsResultSchema = losslessWireResultSchema(
  "tools/list",
  V2ListToolsResultSchema,
);
export const mcpListResourceTemplatesResultSchema = losslessWireResultSchema(
  "resources/templates/list",
  V2ListResourceTemplatesResultSchema,
);
export const mcpGetPromptResultSchema = losslessWireResultSchema(
  "prompts/get",
  V2GetPromptResultSchema,
);

function legacyResult<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  // A successful parse can still strip fields in nested v1 schemas.
  if (!parsed.success || !isDeepStrictEqual(value, parsed.data)) {
    throw new McpSdkCompatibilityError(method);
  }
  return parsed.data;
}

export function toLegacyMcpCallToolResult(value: CallToolResult) {
  return legacyResult("tools/call", CallToolResultSchema, value);
}

export function toLegacyMcpListToolsResult(value: ListToolsResult) {
  return legacyResult("tools/list", ListToolsResultSchema, value);
}

export function toLegacyMcpListResourceTemplatesResult(value: ListResourceTemplatesResult) {
  return legacyResult("resources/templates/list", ListResourceTemplatesResultSchema, value);
}

export function toLegacyMcpGetPromptResult(value: GetPromptResult) {
  return legacyResult("prompts/get", GetPromptResultSchema, value);
}
