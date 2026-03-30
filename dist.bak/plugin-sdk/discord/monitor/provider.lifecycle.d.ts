import type { Client } from "@buape/carbon";
import type { RuntimeEnv } from "../../runtime.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
type ExecApprovalsHandler = {
    start: () => Promise<void>;
    stop: () => Promise<void>;
};
export declare function runDiscordGatewayLifecycle(params: {
    accountId: string;
    client: Client;
    runtime: RuntimeEnv;
    abortSignal?: AbortSignal;
    isDisallowedIntentsError: (err: unknown) => boolean;
    voiceManager: DiscordVoiceManager | null;
    voiceManagerRef: {
        current: DiscordVoiceManager | null;
    };
    execApprovalsHandler: ExecApprovalsHandler | null;
    threadBindings: {
        stop: () => void;
    };
    pendingGatewayErrors?: unknown[];
    releaseEarlyGatewayErrorGuard?: () => void;
}): Promise<void>;
export {};
