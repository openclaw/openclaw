import { createJsonSchemaValidatorProvider } from "openclaw/plugin-sdk/json-schema-validator";

type SchemaProvider = ReturnType<typeof createJsonSchemaValidatorProvider>;
type JsonSchema = Parameters<SchemaProvider["getValidator"]>[0];

type LobsterSchemaError = {
  instancePath: string;
  message: string;
};

type LobsterSchemaValidator = {
  (value: unknown): boolean;
  errors: LobsterSchemaError[] | null;
};

export type LobsterSchemaCompiler = (
  schema: JsonSchema,
  options: { scope: object; allErrors: boolean; addUsedSchema: boolean },
) => LobsterSchemaValidator;

const providers = new WeakMap<object, SchemaProvider>();
const createProvider = () =>
  createJsonSchemaValidatorProvider({
    dialect: "draft7",
    formats: new Map(),
    validateSchema: true,
    duplicateIds: "reject",
  });
/** Keep each dependency-owned Ajv namespace for that engine's module lifetime. */
export const compileLobsterSchema: LobsterSchemaCompiler = (schema, options) => {
  let provider = options.addUsedSchema ? providers.get(options.scope) : undefined;
  if (!provider) {
    provider = createProvider();
    if (options.addUsedSchema) {
      providers.set(options.scope, provider);
    }
  }
  const prepared = provider.getValidator(schema);
  const validate: LobsterSchemaValidator = Object.assign(
    (value: unknown) => {
      if (prepared.check(value)) {
        validate.errors = null;
        return true;
      }
      const errors = prepared.errors(value);
      validate.errors = (options.allErrors ? errors : errors.slice(0, 1)).map((error) => ({
        instancePath: error.instancePath ?? "",
        message: error.message ?? "schema validation failed",
      }));
      return false;
    },
    { errors: null },
  );
  return validate;
};
