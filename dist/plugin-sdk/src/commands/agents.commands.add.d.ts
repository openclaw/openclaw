import { type RuntimeEnv } from "../runtime.js";
type AgentsAddOptions = {
    name?: string;
    workspace?: string;
    model?: string;
    agentDir?: string;
    bind?: string[];
    nonInteractive?: boolean;
    json?: boolean;
};
declare function copyPortableAuthProfiles(params: {
    destAuthPath: string;
    sourceAgentDir: string;
}): Promise<{
    copied: number;
    skipped: number;
}>;
declare function formatSkippedOAuthProfilesMessage(params: {
    sourceAgentId: string;
    sourceIsInheritedMain: boolean;
}): string;
export declare function agentsAddCommand(opts: AgentsAddOptions, runtime?: RuntimeEnv, params?: {
    hasFlags?: boolean;
}): Promise<void>;
export declare const __testing: {
    copyPortableAuthProfiles: typeof copyPortableAuthProfiles;
    formatSkippedOAuthProfilesMessage: typeof formatSkippedOAuthProfilesMessage;
};
export {};
