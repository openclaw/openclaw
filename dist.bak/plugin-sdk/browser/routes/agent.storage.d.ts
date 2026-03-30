import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRouteRegistrar } from "./types.js";
type StorageKind = "local" | "session";
export declare function parseStorageKind(raw: string): StorageKind | null;
export declare function parseStorageMutationRequest(kindParam: unknown, body: Record<string, unknown>): {
    kind: StorageKind | null;
    targetId: string | undefined;
};
export declare function parseRequiredStorageMutationRequest(kindParam: unknown, body: Record<string, unknown>): {
    kind: StorageKind;
    targetId: string | undefined;
} | null;
export declare function registerBrowserAgentStorageRoutes(app: BrowserRouteRegistrar, ctx: BrowserRouteContext): void;
export {};
