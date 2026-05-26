import type { RuntimeEnv } from "../runtime.js";
type FacadeModule = {
    githubCopilotLoginCommand: (opts: {
        profileId?: string;
        yes?: boolean;
        agentDir?: string;
    }, runtime: RuntimeEnv) => Promise<void>;
};
/** @deprecated GitHub Copilot provider-owned login helper; use provider auth hooks instead. */
export declare const githubCopilotLoginCommand: FacadeModule["githubCopilotLoginCommand"];
export {};
