import type { JsonSchemaObject } from "../shared/json-schema.types.js";
export type JsonSchemaValue = JsonSchemaObject | boolean;
export type JsonSchemaValidationError = {
    path: string;
    message: string;
    text: string;
    additionalProperty?: string;
    allowedValues?: string[];
    allowedValuesHiddenCount?: number;
};
export declare function validateJsonSchemaValue(params: {
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
