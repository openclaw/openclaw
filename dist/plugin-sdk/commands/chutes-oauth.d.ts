import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { ChutesOAuthAppConfig } from "../agents/chutes-oauth.js";
import { generateChutesPkce } from "../agents/chutes-oauth.js";
type OAuthPrompt = {
    message: string;
    placeholder?: string;
};
export declare function loginChutes(params: {
    app: ChutesOAuthAppConfig;
    manual?: boolean;
    timeoutMs?: number;
    createPkce?: typeof generateChutesPkce;
    createState?: () => string;
    onAuth: (event: {
        url: string;
    }) => Promise<void>;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
    onProgress?: (message: string) => void;
    fetchFn?: typeof fetch;
}): Promise<OAuthCredentials>;
export {};
