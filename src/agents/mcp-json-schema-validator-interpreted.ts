import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import type { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { JsonSchemaRefinement } from "@openclaw/normalization-core/json-schema";
import type { JsonSchemaValidator as PreparedValidator } from "@openclaw/normalization-core/json-schema-validator";
import {
  createJsonSchemaValidatorProvider,
  type JsonSchemaValidatorProvider,
} from "../shared/json-schema-validator.js";

const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const annotationFormats = new Map<string, JsonSchemaRefinement>();
type McpFormats = Readonly<InstanceType<typeof Ajv>["formats"]>;

function createFormatRefinement(
  name: string,
  definition: Exclude<McpFormats[string], undefined>,
): JsonSchemaRefinement | undefined {
  const error = () => `must match format "${name}"`;
  if (definition === true) {
    return undefined;
  }
  if (typeof definition === "function") {
    return { check: (value) => typeof value !== "string" || definition(value), error };
  }
  if (definition instanceof RegExp) {
    return { check: (value) => typeof value !== "string" || definition.test(value), error };
  }
  if (definition.async) {
    throw new Error(`Unsupported MCP JSON Schema format definition: ${name}`);
  }
  if (definition.type === "number") {
    return {
      check: (value) => typeof value !== "number" || definition.validate(value),
      error,
    };
  }
  const validate = definition.validate;
  if (typeof validate === "string") {
    throw new Error(`Unsupported MCP JSON Schema format definition: ${name}`);
  }
  return {
    check: (value) => {
      if (typeof value !== "string") {
        return true;
      }
      if (validate instanceof RegExp) {
        return validate.test(value);
      }
      // Ajv's optional format type does not discriminate its callback union.
      const accepted: unknown = Reflect.apply(validate, undefined, [value]);
      return accepted === true;
    },
    error,
  };
}

function createFormatRefinements(formats: McpFormats): ReadonlyMap<string, JsonSchemaRefinement> {
  const refinements = new Map<string, JsonSchemaRefinement>();
  for (const [name, definition] of Object.entries(formats)) {
    if (definition === undefined) {
      continue;
    }
    const refinement = createFormatRefinement(name, definition);
    if (refinement) {
      refinements.set(name, refinement);
    }
  }
  return refinements;
}

function formatErrors(errors: ReturnType<PreparedValidator["errors"]>): string {
  return (
    errors
      .map((error) => {
        const message = error.message?.trim() || "schema validation failed";
        return error.instancePath ? `${error.instancePath} ${message}` : message;
      })
      .join(", ") || "schema validation failed"
  );
}

/** Code-generation-free MCP validation with the existing draft and format policies. */
export function createInterpretedMcpJsonSchemaValidator(formats: McpFormats): jsonSchemaValidator {
  let draft7Provider: JsonSchemaValidatorProvider | undefined;
  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      const modern = schema.$schema === DRAFT_2020_12_SCHEMA;
      let validator: PreparedValidator;
      try {
        const provider = modern
          ? createJsonSchemaValidatorProvider({ dialect: "2020-12", formats: annotationFormats })
          : (draft7Provider ??= createJsonSchemaValidatorProvider({
              dialect: "draft7",
              formats: createFormatRefinements(formats),
            }));
        validator = provider.getValidator(schema);
      } catch (error) {
        const setupError = toErrorObject(error, "schema setup failed");
        throw new Error(
          `Invalid MCP ${modern ? "draft-2020-12 " : ""}JSON Schema: ${setupError.message}`,
          { cause: error },
        );
      }
      return (input: unknown) => {
        if (validator.check(input)) {
          // SAFETY: The SDK pairs T with this runtime schema; its successful check admits input.
          return { valid: true, data: input as T, errorMessage: undefined };
        }
        return {
          valid: false,
          data: undefined,
          errorMessage: formatErrors(validator.errors(input)),
        };
      };
    },
  };
}
