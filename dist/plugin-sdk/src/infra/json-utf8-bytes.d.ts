export declare function jsonUtf8Bytes(value: unknown): number;
export type BoundedJsonUtf8Bytes = {
    bytes: number;
    complete: boolean;
};
export declare function jsonUtf8BytesOrInfinity(value: unknown): number;
export declare function firstEnumerableOwnKeys(value: object, maxKeys: number): string[];
export declare function boundedJsonUtf8Bytes(value: unknown, maxBytes: number): BoundedJsonUtf8Bytes;
