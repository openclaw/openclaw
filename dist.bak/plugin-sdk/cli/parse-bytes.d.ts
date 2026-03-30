export type BytesParseOptions = {
    defaultUnit?: "b" | "kb" | "mb" | "gb" | "tb";
};
export declare function parseByteSize(raw: string, opts?: BytesParseOptions): number;
