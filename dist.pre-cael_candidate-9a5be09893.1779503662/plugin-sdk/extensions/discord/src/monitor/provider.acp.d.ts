import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
type DiscordProviderSessionRuntimeModule = typeof import("./provider-session.runtime.js");
export declare function probeDiscordAcpBindingHealth(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    storedState?: "idle" | "running" | "error";
    lastActivityAt?: number;
    providerSessionRuntime: DiscordProviderSessionRuntimeModule;
}): Promise<{
    status: "healthy" | "stale" | "uncertain";
    reason?: string;
}>;
export {};
