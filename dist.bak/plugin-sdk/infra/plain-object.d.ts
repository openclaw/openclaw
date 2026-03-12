/**
 * Strict plain-object guard (excludes arrays and host objects).
 */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
