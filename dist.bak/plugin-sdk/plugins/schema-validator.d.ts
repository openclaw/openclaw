export declare function validateJsonSchemaValue(params: {
    schema: Record<string, unknown>;
    cacheKey: string;
    value: unknown;
}): {
    ok: true;
} | {
    ok: false;
    errors: string[];
};
