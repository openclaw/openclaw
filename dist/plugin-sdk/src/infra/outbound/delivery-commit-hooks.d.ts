import type { OutboundDeliveryResult } from "./deliver-types.js";
export type OutboundDeliveryCommitHook = () => Promise<void>;
export declare function attachOutboundDeliveryCommitHook<T extends OutboundDeliveryResult>(result: T, hook?: OutboundDeliveryCommitHook): T;
export declare function runOutboundDeliveryCommitHooks(results: readonly OutboundDeliveryResult[]): Promise<void>;
export declare function isOutboundDeliveryResultArray(value: unknown): value is OutboundDeliveryResult[];
