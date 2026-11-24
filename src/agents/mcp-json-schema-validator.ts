import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import {
  Ajv,
  addFormats,
  AjvJsonSchemaValidator,
} from "@modelcontextprotocol/client/validators/ajv";
import {
  normalizeJsonSchemaForTypeBox,
  type JsonSchemaRefinement,
} from "@openclaw/normalization-core/json-schema";
import type { JsonSchemaValidator as PreparedValidator } from "@openclaw/normalization-core/json-schema-validator";
import fastUri from "fast-uri";
import { Compile } from "typebox/compile";
import { getRuntimeExecutionProfile } from "../../standalone-runtime-profile.mjs";
import { toErrorObject } from "../infra/errors.js";
import { logDebug } from "../logger.js";
import { findJsonSchemaShapeError } from "../shared/json-schema-defaults.js";
import {
  createJsonSchemaValidatorProvider,
  type JsonSchemaValidatorProvider,
} from "../shared/json-schema-validator.js";

const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const annotationFormats = new Map<string, JsonSchemaRefinement>();
type McpFormats = Readonly<InstanceType<typeof Ajv>["formats"]>;

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
  // Preserve the legacy draft-07 default and the workspace URI resolver; the SDK bundles its own.
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    uriResolver: fastUri,
    // Unknown vendor formats are annotations, so their notices belong at debug level.
    logger: { log: console.log, warn: logDebug, error: console.error },
  });
  addFormats(ajv);
  if (getRuntimeExecutionProfile() === "embedded-aot") {
    return createInterpretedMcpJsonSchemaValidator(ajv.formats);
  }
  const defaultValidator = new AjvJsonSchemaValidator(ajv);

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      if (schema.$schema !== DRAFT_2020_12_SCHEMA) {
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

/** Code-generation-free MCP validation with the existing draft and format policies. */
function createInterpretedMcpJsonSchemaValidator(formats: McpFormats): jsonSchemaValidator {
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
          errorMessage: formatTypeBoxErrors(validator.errors(input)),
        };
      };
    },
  };
}
