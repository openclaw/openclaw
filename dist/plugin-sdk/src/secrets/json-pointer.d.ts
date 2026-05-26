export declare function encodeJsonPointerToken(token: string): string;
export declare function readJsonPointer(root: unknown, pointer: string, options?: {
    onMissing?: "throw" | "undefined";
}): unknown;
