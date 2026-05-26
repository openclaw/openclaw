export declare function extractModelDirective(body?: string, options?: {
    aliases?: string[];
}): {
    cleaned: string;
    rawModel?: string;
    rawProfile?: string;
    rawRuntime?: string;
    hasDirective: boolean;
};
