/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
export declare function resolveCitationRedirectUrl(url: string): Promise<string>;
