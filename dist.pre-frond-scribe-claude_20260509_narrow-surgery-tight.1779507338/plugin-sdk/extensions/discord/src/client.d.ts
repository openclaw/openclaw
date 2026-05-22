import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RetryConfig, RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { type ResolvedDiscordAccount } from "./accounts.js";
import { RequestClient } from "./internal/discord.js";
import type { DiscordRuntimeAccountContext } from "./send.types.js";
export type DiscordClientOpts = {
    cfg: OpenClawConfig;
    token?: string;
    accountId?: string;
    rest?: RequestClient;
    retry?: RetryConfig;
    verbose?: boolean;
};
export declare function createDiscordRuntimeAccountContext(params: {
    cfg: OpenClawConfig;
    accountId: string;
}): DiscordRuntimeAccountContext;
export declare function resolveDiscordClientAccountContext(opts: Pick<DiscordClientOpts, "cfg" | "accountId">, runtime?: Pick<RuntimeEnv, "error">): {
    cfg: OpenClawConfig;
    account: ResolvedDiscordAccount;
    proxyFetch: typeof fetch | undefined;
};
export declare function createDiscordRestClient(opts: DiscordClientOpts): {
    token: string;
    rest: RequestClient;
    account: ResolvedDiscordAccount;
};
export declare function createDiscordClient(opts: DiscordClientOpts): {
    token: string;
    rest: RequestClient;
    request: RetryRunner;
};
export declare function resolveDiscordRest(opts: DiscordClientOpts): RequestClient;
