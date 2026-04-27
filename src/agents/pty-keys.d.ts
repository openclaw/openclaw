export declare const BRACKETED_PASTE_START = "\u001B[200~";
export declare const BRACKETED_PASTE_END = "\u001B[201~";
export type KeyEncodingRequest = {
    keys?: string[];
    hex?: string[];
    literal?: string;
};
export type KeyEncodingResult = {
    data: string;
    warnings: string[];
};
export declare function hasCursorModeSensitiveKeys(request: KeyEncodingRequest): boolean;
export declare function encodeKeySequence(request: KeyEncodingRequest, cursorKeyMode?: "normal" | "application"): KeyEncodingResult;
export declare function encodePaste(text: string, bracketed?: boolean): string;
