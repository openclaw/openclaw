export declare function extractInlineSimpleCommand(body?: string): {
    command: string;
    cleaned: string;
} | null;
export declare function stripInlineStatus(body: string): {
    cleaned: string;
    didStrip: boolean;
};
