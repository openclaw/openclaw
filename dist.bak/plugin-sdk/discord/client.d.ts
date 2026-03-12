import { RequestClient } from "@buape/carbon";
import { type RetryRunner } from "../infra/retry-policy.js";
import type { RetryConfig } from "../infra/retry.js";
export type DiscordClientOpts = {
    token?: string;
    accountId?: string;
    rest?: RequestClient;
    retry?: RetryConfig;
    verbose?: boolean;
};
export declare function createDiscordRestClient(opts: DiscordClientOpts, cfg?: import("../config/types.openclaw.ts").OpenClawConfig): {
    token: string;
    rest: RequestClient;
    account: import("./accounts.js").ResolvedDiscordAccount;
};
export declare function createDiscordClient(opts: DiscordClientOpts, cfg?: import("../config/types.openclaw.ts").OpenClawConfig): {
    token: string;
    rest: RequestClient;
    request: RetryRunner;
};
export declare function resolveDiscordRest(opts: DiscordClientOpts): RequestClient;
