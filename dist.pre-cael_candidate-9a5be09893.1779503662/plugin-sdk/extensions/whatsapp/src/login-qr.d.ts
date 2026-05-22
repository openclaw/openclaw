import { type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { WHATSAPP_AUTH_UNSTABLE_CODE } from "./session.js";
export type StartWebLoginWithQrResult = {
    qrDataUrl?: string;
    message: string;
    connected?: boolean;
    code?: typeof WHATSAPP_AUTH_UNSTABLE_CODE;
};
export declare function startWebLoginWithQr(opts?: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
}): Promise<StartWebLoginWithQrResult>;
export declare function waitForWebLogin(opts?: {
    timeoutMs?: number;
    runtime?: RuntimeEnv;
    accountId?: string;
    currentQrDataUrl?: string;
}): Promise<{
    connected: boolean;
    message: string;
    qrDataUrl?: string;
}>;
