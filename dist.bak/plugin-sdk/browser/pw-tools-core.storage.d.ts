export declare function cookiesGetViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<{
    cookies: unknown[];
}>;
export declare function cookiesSetViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    cookie: {
        name: string;
        value: string;
        url?: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "Lax" | "None" | "Strict";
    };
}): Promise<void>;
export declare function cookiesClearViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<void>;
type StorageKind = "local" | "session";
export declare function storageGetViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    kind: StorageKind;
    key?: string;
}): Promise<{
    values: Record<string, string>;
}>;
export declare function storageSetViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    kind: StorageKind;
    key: string;
    value: string;
}): Promise<void>;
export declare function storageClearViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    kind: StorageKind;
}): Promise<void>;
export {};
