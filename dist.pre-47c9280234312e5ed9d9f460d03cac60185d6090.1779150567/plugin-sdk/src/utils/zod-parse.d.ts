import type { ZodType } from "zod";
export declare function safeParseWithSchema<T>(schema: ZodType<T>, value: unknown): T | null;
export declare function safeParseJsonWithSchema<T>(schema: ZodType<T>, raw: string): T | null;
