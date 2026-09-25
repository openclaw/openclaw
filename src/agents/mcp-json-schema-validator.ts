import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { Compile } from "typebox/compile";
import { toErrorObject } from "../infra/errors.js";
import { findJsonSchemaShapeError } from "../shared/json-schema-defaults.js";

const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

function isDraft202012Schema(schema: JsonSchemaType): boolean {
  return (schema as { $schema?: unknown }).$schema === DRAFT_2020_12_SCHEMA;
}

function formatTypeBoxErrors(errors: Array<{ instancePath?: string; message?: string }>): string {
  return (
    errors
      .map((error) => {
        const message = error.message?.trim() || "schema validation failed";
        return error.instancePath ? `${error.instancePath} ${message}` : message;
      })
      .join(", ") || "schema validation failed"
  );
}

/** MCP SDK validator with draft-2020-12 support for external tool schemas. */
export function createMcpJsonSchemaValidator(): jsonSchemaValidator {
  const defaultValidator = new AjvJsonSchemaValidator();

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      if (!isDraft202012Schema(schema)) {
        return defaultValidator.getValidator<T>(schema);
      }
      let validator: ReturnType<typeof Compile>;
      try {
        const schemaError = findJsonSchemaShapeError(schema as never);
        if (schemaError) {
          throw new Error(schemaError);
        }
        validator = Compile(
          normalizeJsonSchemaForTypeBox(schema, { format: "annotation" }) as never,
        );
      } catch (error) {
        const setupError = toErrorObject(error, "schema setup failed");
        throw new Error(`Invalid MCP draft-2020-12 JSON Schema: ${setupError.message}`, {
          cause: error,
        });
      }
      return (input: unknown) => {
        const valid = validator.Check(input);
        if (valid) {
          return { valid: true, data: input as T, errorMessage: undefined };
        }
        return {
          valid: false,
          data: undefined,
          errorMessage: formatTypeBoxErrors([...validator.Errors(input)]),
        };
      };
    },
  };
}
