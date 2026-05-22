import { t as JsonSchemaObject } from "./json-schema.types-BYet9RVQ.js";

//#region src/plugins/schema-validator.d.ts
type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  additionalProperty?: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};
declare function validateJsonSchemaValue(params: {
  schema: JsonSchemaObject;
  cacheKey: string;
  value: unknown;
  applyDefaults?: boolean;
  cache?: boolean;
}): {
  ok: true;
  value: unknown;
} | {
  ok: false;
  errors: JsonSchemaValidationError[];
};
//#endregion
export { validateJsonSchemaValue as t };