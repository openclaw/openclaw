import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export declare function loginOpenAICodexOAuth(params: {
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    isRemote: boolean;
    openUrl: (url: string) => Promise<void>;
    localBrowserMessage?: string;
}): Promise<OAuthCredentials | null>;
