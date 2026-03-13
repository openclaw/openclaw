export type JsonSchemaValidationError = {
    path: string;
    message: string;
    text: string;
    allowedValues?: string[];
    allowedValuesHiddenCount?: number;
};
export declare function validateJsonSchemaValue(params: {
    schema: Record<string, unknown>;
    cacheKey: string;
    value: unknown;
}): {
    ok: true;
} | {
    ok: false;
    errors: JsonSchemaValidationError[];
};
