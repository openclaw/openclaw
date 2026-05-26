import { t as JsonSchemaObject } from "./json-schema.types-fpZiub1R.js";

//#region src/plugins/schema-validator.d.ts
type JsonSchemaValue = JsonSchemaObject | boolean;
type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  additionalProperty?: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};
declare function validateJsonSchemaValue(params: {
  schema: JsonSchemaValue;
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