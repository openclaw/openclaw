import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
/**
 * Extract profile name from query string or body and get profile context.
 * Query string takes precedence over body for consistency with GET routes.
 */
export declare function getProfileContext(req: BrowserRequest, ctx: BrowserRouteContext): ProfileContext | {
    error: string;
    status: number;
};
export declare function jsonError(res: BrowserResponse, status: number, message: string): void;
export declare function toStringOrEmpty(value: unknown): string;
export declare function toNumber(value: unknown): number | undefined;
export declare function toBoolean(value: unknown): boolean | undefined;
export declare function toStringArray(value: unknown): string[] | undefined;
