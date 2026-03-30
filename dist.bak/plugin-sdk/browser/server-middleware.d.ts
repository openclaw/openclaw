import type { Express } from "express";
export declare function installBrowserCommonMiddleware(app: Express): void;
export declare function installBrowserAuthMiddleware(app: Express, auth: {
    token?: string;
    password?: string;
}): void;
