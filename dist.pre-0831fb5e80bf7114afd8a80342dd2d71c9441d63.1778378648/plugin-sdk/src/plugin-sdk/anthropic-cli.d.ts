type FacadeModule = {
    CLAUDE_CLI_BACKEND_ID: string;
    isClaudeCliProvider: (providerId: string) => boolean;
};
export declare const CLAUDE_CLI_BACKEND_ID: FacadeModule["CLAUDE_CLI_BACKEND_ID"];
export declare const isClaudeCliProvider: FacadeModule["isClaudeCliProvider"];
export {};
