export type AgentIdentityFile = {
    name?: string;
    emoji?: string;
    theme?: string;
    creature?: string;
    vibe?: string;
    avatar?: string;
};
export declare function parseIdentityMarkdown(content: string): AgentIdentityFile;
export declare function identityHasValues(identity: AgentIdentityFile): boolean;
export declare function loadIdentityFromFile(identityPath: string): AgentIdentityFile | null;
export declare function loadAgentIdentityFromWorkspace(workspace: string): AgentIdentityFile | null;
