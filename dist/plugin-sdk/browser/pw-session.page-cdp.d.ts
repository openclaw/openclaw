import type { Page } from "playwright-core";
type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export declare function isExtensionRelayCdpEndpoint(cdpUrl: string): Promise<boolean>;
export declare function withPageScopedCdpClient<T>(opts: {
    cdpUrl: string;
    page: Page;
    targetId?: string;
    fn: (send: PageCdpSend) => Promise<T>;
}): Promise<T>;
export {};
