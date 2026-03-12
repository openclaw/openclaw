import type { IncomingMessage, ServerResponse } from "node:http";
export type RegisteredWebhookTarget<T> = {
    target: T;
    unregister: () => void;
};
export declare function registerWebhookTarget<T extends {
    path: string;
}>(targetsByPath: Map<string, T[]>, target: T): RegisteredWebhookTarget<T>;
export declare function resolveWebhookTargets<T>(req: IncomingMessage, targetsByPath: Map<string, T[]>): {
    path: string;
    targets: T[];
} | null;
export type WebhookTargetMatchResult<T> = {
    kind: "none";
} | {
    kind: "single";
    target: T;
} | {
    kind: "ambiguous";
};
export declare function resolveSingleWebhookTarget<T>(targets: readonly T[], isMatch: (target: T) => boolean): WebhookTargetMatchResult<T>;
export declare function resolveSingleWebhookTargetAsync<T>(targets: readonly T[], isMatch: (target: T) => Promise<boolean>): Promise<WebhookTargetMatchResult<T>>;
export declare function rejectNonPostWebhookRequest(req: IncomingMessage, res: ServerResponse): boolean;
