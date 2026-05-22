import { z, type ZodType } from "zod";
export declare const LowercaseNonEmptyStringFieldSchema: z.ZodPreprocess<z.ZodString>;
export declare const TrimmedNonEmptyStringFieldSchema: z.ZodPreprocess<z.ZodString>;
export declare const DeliveryThreadIdFieldSchema: z.ZodUnion<readonly [z.ZodPreprocess<z.ZodString>, z.ZodNumber]>;
export declare const TimeoutSecondsFieldSchema: z.ZodPipe<z.ZodNumber, z.ZodTransform<number, number>>;
type ParsedDeliveryInput = {
    mode?: "announce" | "none" | "webhook";
    channel?: string;
    to?: string;
    threadId?: string | number;
    accountId?: string;
};
export declare function parseDeliveryInput(input: Record<string, unknown>): ParsedDeliveryInput;
export declare function parseOptionalField<T>(schema: ZodType<T>, value: unknown): T | undefined;
export {};
