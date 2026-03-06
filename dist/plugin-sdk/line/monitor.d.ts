import type { WebhookRequestBody } from "@line/bot-sdk";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedLineAccount } from "./types.js";
export interface MonitorLineProviderOptions {
    channelAccessToken: string;
    channelSecret: string;
    accountId?: string;
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    abortSignal?: AbortSignal;
    webhookUrl?: string;
    webhookPath?: string;
}
export interface LineProviderMonitor {
    account: ResolvedLineAccount;
    handleWebhook: (body: WebhookRequestBody) => Promise<void>;
    stop: () => void;
}
export declare function getLineRuntimeState(accountId: string): {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
} | undefined;
export declare function monitorLineProvider(opts: MonitorLineProviderOptions): Promise<LineProviderMonitor>;
