import type { RuntimeEnv } from "../runtime.js";
type FacadeModule = {
    githubCopilotLoginCommand: (opts: {
        profileId?: string;
        yes?: boolean;
        agentDir?: string;
    }, runtime: RuntimeEnv) => Promise<void>;
};
export declare const githubCopilotLoginCommand: FacadeModule["githubCopilotLoginCommand"];
export {};
