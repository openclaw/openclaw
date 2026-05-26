/** Read loose boolean params from tool input that may arrive as booleans or "true"/"false" strings. */
export declare function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined;
