export declare function setOfflineViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    offline: boolean;
}): Promise<void>;
export declare function setExtraHTTPHeadersViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    headers: Record<string, string>;
}): Promise<void>;
export declare function setHttpCredentialsViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    username?: string;
    password?: string;
    clear?: boolean;
}): Promise<void>;
export declare function setGeolocationViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    origin?: string;
    clear?: boolean;
}): Promise<void>;
export declare function emulateMediaViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    colorScheme: "dark" | "light" | "no-preference" | null;
}): Promise<void>;
export declare function setLocaleViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    locale: string;
}): Promise<void>;
export declare function setTimezoneViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    timezoneId: string;
}): Promise<void>;
export declare function setDeviceViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    name: string;
}): Promise<void>;
