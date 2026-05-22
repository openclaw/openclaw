export declare function wrapNoteMessage(message: unknown, options?: {
    maxWidth?: number;
    columns?: number;
}): string;
export declare function resolveNoteColumns(columns: number | undefined): number;
export declare function note(message: unknown, title?: string): void;
export declare function withSuppressedNotes<T>(callback: () => T): T;
