import type { BrowserActionOk, BrowserActionTargetOk } from "./client-actions-types.js";
export declare function browserCookies(baseUrl: string | undefined, opts?: {
    targetId?: string;
    profile?: string;
}): Promise<{
    ok: true;
    targetId: string;
    cookies: unknown[];
}>;
export declare function browserCookiesSet(baseUrl: string | undefined, opts: {
    cookie: Record<string, unknown>;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserCookiesClear(baseUrl: string | undefined, opts?: {
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserStorageGet(baseUrl: string | undefined, opts: {
    kind: "local" | "session";
    key?: string;
    targetId?: string;
    profile?: string;
}): Promise<{
    ok: true;
    targetId: string;
    values: Record<string, string>;
}>;
export declare function browserStorageSet(baseUrl: string | undefined, opts: {
    kind: "local" | "session";
    key: string;
    value: string;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserStorageClear(baseUrl: string | undefined, opts: {
    kind: "local" | "session";
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetOffline(baseUrl: string | undefined, opts: {
    offline: boolean;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetHeaders(baseUrl: string | undefined, opts: {
    headers: Record<string, string>;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetHttpCredentials(baseUrl: string | undefined, opts?: {
    username?: string;
    password?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetGeolocation(baseUrl: string | undefined, opts?: {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    origin?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetMedia(baseUrl: string | undefined, opts: {
    colorScheme: "dark" | "light" | "no-preference" | "none";
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetTimezone(baseUrl: string | undefined, opts: {
    timezoneId: string;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetLocale(baseUrl: string | undefined, opts: {
    locale: string;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserSetDevice(baseUrl: string | undefined, opts: {
    name: string;
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionTargetOk>;
export declare function browserClearPermissions(baseUrl: string | undefined, opts?: {
    targetId?: string;
    profile?: string;
}): Promise<BrowserActionOk>;
