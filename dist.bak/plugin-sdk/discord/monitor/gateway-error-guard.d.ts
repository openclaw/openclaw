import type { Client } from "@buape/carbon";
export type EarlyGatewayErrorGuard = {
    pendingErrors: unknown[];
    release: () => void;
};
export declare function attachEarlyGatewayErrorGuard(client: Client): EarlyGatewayErrorGuard;
