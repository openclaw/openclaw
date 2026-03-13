import { type LookupFn, type SsrFPolicy } from "../infra/net/ssrf.js";
export declare class InvalidBrowserNavigationUrlError extends Error {
    constructor(message: string);
}
export type BrowserNavigationPolicyOptions = {
    ssrfPolicy?: SsrFPolicy;
};
export type BrowserNavigationRequestLike = {
    url(): string;
    redirectedFrom(): BrowserNavigationRequestLike | null;
};
export declare function withBrowserNavigationPolicy(ssrfPolicy?: SsrFPolicy): BrowserNavigationPolicyOptions;
export declare function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrFPolicy): boolean;
export declare function assertBrowserNavigationAllowed(opts: {
    url: string;
    lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void>;
/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://).
 */
export declare function assertBrowserNavigationResultAllowed(opts: {
    url: string;
    lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void>;
export declare function assertBrowserNavigationRedirectChainAllowed(opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void>;
