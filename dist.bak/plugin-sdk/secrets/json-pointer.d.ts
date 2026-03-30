export declare function decodeJsonPointerToken(token: string): string;
export declare function encodeJsonPointerToken(token: string): string;
export declare function readJsonPointer(root: unknown, pointer: string, options?: {
    onMissing?: "throw" | "undefined";
}): unknown;
export declare function setJsonPointer(root: Record<string, unknown>, pointer: string, value: unknown): void;
