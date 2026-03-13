export declare const NOVNC_PASSWORD_ENV_KEY = "OPENCLAW_BROWSER_NOVNC_PASSWORD";
export type NoVncObserverTokenPayload = {
    noVncPort: number;
    password?: string;
};
export declare function isNoVncEnabled(params: {
    enableNoVnc: boolean;
    headless: boolean;
}): boolean;
export declare function generateNoVncPassword(): string;
export declare function buildNoVncDirectUrl(port: number): string;
export declare function buildNoVncObserverTargetUrl(params: {
    port: number;
    password?: string;
}): string;
export declare function issueNoVncObserverToken(params: {
    noVncPort: number;
    password?: string;
    ttlMs?: number;
    nowMs?: number;
}): string;
export declare function consumeNoVncObserverToken(token: string, nowMs?: number): NoVncObserverTokenPayload | null;
export declare function buildNoVncObserverTokenUrl(baseUrl: string, token: string): string;
export declare function resetNoVncObserverTokensForTests(): void;
