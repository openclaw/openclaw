export declare const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD";
export declare function isNoVncEnabled(params: {
    enableNoVnc: boolean;
    headless: boolean;
}): boolean;
export declare function generateNoVncPassword(): string;
export declare function buildNoVncDirectUrl(port: number, password?: string): string;
export declare function issueNoVncObserverToken(params: {
    url: string;
    ttlMs?: number;
    nowMs?: number;
}): string;
export declare function consumeNoVncObserverToken(token: string, nowMs?: number): string | null;
export declare function buildNoVncObserverTokenUrl(baseUrl: string, token: string): string;
export declare function resetNoVncObserverTokensForTests(): void;
