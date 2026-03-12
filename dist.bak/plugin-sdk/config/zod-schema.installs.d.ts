import { z } from "zod";
export declare const InstallSourceSchema: z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">]>;
export declare const InstallRecordShape: {
    readonly source: z.ZodUnion<readonly [z.ZodLiteral<"npm">, z.ZodLiteral<"archive">, z.ZodLiteral<"path">]>;
    readonly spec: z.ZodOptional<z.ZodString>;
    readonly sourcePath: z.ZodOptional<z.ZodString>;
    readonly installPath: z.ZodOptional<z.ZodString>;
    readonly version: z.ZodOptional<z.ZodString>;
    readonly resolvedName: z.ZodOptional<z.ZodString>;
    readonly resolvedVersion: z.ZodOptional<z.ZodString>;
    readonly resolvedSpec: z.ZodOptional<z.ZodString>;
    readonly integrity: z.ZodOptional<z.ZodString>;
    readonly shasum: z.ZodOptional<z.ZodString>;
    readonly resolvedAt: z.ZodOptional<z.ZodString>;
    readonly installedAt: z.ZodOptional<z.ZodString>;
};
