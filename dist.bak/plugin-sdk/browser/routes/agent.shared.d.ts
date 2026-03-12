import type { PwAiModule } from "../pw-ai-module.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
export declare const SELECTOR_UNSUPPORTED_MESSAGE: string;
export declare function readBody(req: BrowserRequest): Record<string, unknown>;
export declare function resolveTargetIdFromBody(body: Record<string, unknown>): string | undefined;
export declare function resolveTargetIdFromQuery(query: Record<string, unknown>): string | undefined;
export declare function handleRouteError(ctx: BrowserRouteContext, res: BrowserResponse, err: unknown): void;
export declare function resolveProfileContext(req: BrowserRequest, res: BrowserResponse, ctx: BrowserRouteContext): ProfileContext | null;
export declare function getPwAiModule(): Promise<PwAiModule | null>;
export declare function requirePwAi(res: BrowserResponse, feature: string): Promise<PwAiModule | null>;
type RouteTabContext = {
    profileCtx: ProfileContext;
    tab: Awaited<ReturnType<ProfileContext["ensureTabAvailable"]>>;
    cdpUrl: string;
};
type RouteTabPwContext = RouteTabContext & {
    pw: PwAiModule;
};
type RouteWithTabParams<T> = {
    req: BrowserRequest;
    res: BrowserResponse;
    ctx: BrowserRouteContext;
    targetId?: string;
    run: (ctx: RouteTabContext) => Promise<T>;
};
export declare function withRouteTabContext<T>(params: RouteWithTabParams<T>): Promise<T | undefined>;
type RouteWithPwParams<T> = {
    req: BrowserRequest;
    res: BrowserResponse;
    ctx: BrowserRouteContext;
    targetId?: string;
    feature: string;
    run: (ctx: RouteTabPwContext) => Promise<T>;
};
export declare function withPlaywrightRouteContext<T>(params: RouteWithPwParams<T>): Promise<T | undefined>;
export {};
