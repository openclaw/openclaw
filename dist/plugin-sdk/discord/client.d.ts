import { RequestClient } from "@buape/carbon";
import { loadConfig } from "../config/config.js";
import { type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
import { type ResolvedDiscordAccount } from "./accounts.js";
export type DiscordClientOpts = {
    cfg?: ReturnType<typeof loadConfig>;
    token?: string;
    accountId?: string;
    rest?: RequestClient;
    retry?: RetryConfig;
    verbose?: boolean;
};
export declare function createDiscordRestClient(opts: DiscordClientOpts, cfg?: ReturnType<typeof loadConfig>): {
    token: string;
    rest: RequestClient;
    account: ResolvedDiscordAccount;
};
export declare function createDiscordClient(opts: DiscordClientOpts, cfg?: ReturnType<typeof loadConfig>): {
    token: string;
    rest: RequestClient;
    request: RetryRunner;
};
export declare function resolveDiscordRest(opts: DiscordClientOpts): RequestClient;
