import type { HandleCommandsParams } from "../commands-types.js";
export declare function resolveBoundAcpThreadSessionKey(params: HandleCommandsParams): string | undefined;
export declare function resolveAcpTargetSessionKey(params: {
    commandParams: HandleCommandsParams;
    token?: string;
}): Promise<{
    ok: true;
    sessionKey: string;
} | {
    ok: false;
    error: string;
}>;
