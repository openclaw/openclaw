import type { Api, Model } from "@mariozechner/pi-ai";
export declare function resolveModelRequestTimeoutMs(model: Model<Api>, timeoutMs: number | undefined): number | undefined;
export declare function buildGuardedModelFetch(model: Model<Api>, timeoutMs?: number): typeof fetch;
