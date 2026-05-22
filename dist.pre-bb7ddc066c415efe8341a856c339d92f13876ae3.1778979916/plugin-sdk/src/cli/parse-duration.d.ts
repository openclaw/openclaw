export type DurationMsParseOptions = {
    defaultUnit?: "ms" | "s" | "m" | "h" | "d";
};
export declare function parseDurationMs(raw: string, opts?: DurationMsParseOptions): number;
