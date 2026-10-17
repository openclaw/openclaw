import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { Ajv } from "ajv";
import ajvFormats from "ajv-formats";
import { Compile } from "typebox/compile";
import { toErrorObject } from "../infra/errors.js";
import { logDebug } from "../logger.js";
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

// Matches the MCP SDK's default Ajv options. Remote servers routinely publish
// vendor formats (google-duration, uint) that Ajv ignores; its notice for each
// one belongs in debug logs, not a console warning on every catalog load.
function createAjv(): Ajv {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    logger: {
      log: console.log,
      warn: (...args: unknown[]) => logDebug(`mcp schema: ${args.join(" ")}`),
      error: console.error,
    },
  });
  ajvFormats.default(ajv);
  return ajv;
}

/** MCP SDK validator with draft-2020-12 support for external tool schemas. */
export function createMcpJsonSchemaValidator(): jsonSchemaValidator {
  const defaultValidator = new AjvJsonSchemaValidator(createAjv());

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
