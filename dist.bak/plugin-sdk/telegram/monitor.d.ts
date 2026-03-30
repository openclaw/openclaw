import { type RunOptions } from "@grammyjs/runner";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
export type MonitorTelegramOpts = {
    token?: string;
    accountId?: string;
    config?: OpenClawConfig;
    runtime?: RuntimeEnv;
    abortSignal?: AbortSignal;
    useWebhook?: boolean;
    webhookPath?: string;
    webhookPort?: number;
    webhookSecret?: string;
    webhookHost?: string;
    proxyFetch?: typeof fetch;
    webhookUrl?: string;
};
export declare function createTelegramRunnerOptions(cfg: OpenClawConfig): RunOptions<unknown>;
export declare function monitorTelegramProvider(opts?: MonitorTelegramOpts): Promise<void>;
