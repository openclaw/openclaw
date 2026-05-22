import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";
export type QueuedDeliveryPayload = {
    channel: Exclude<OutboundChannel, "none">;
    to: string;
    accountId?: string;
    /**
     * Original payloads before plugin hooks. On recovery, hooks re-run on these
     * payloads — this is intentional since hooks are stateless transforms and
     * should produce the same result on replay.
     */
    payloads: ReplyPayload[];
    threadId?: string | number | null;
    replyToId?: string | null;
    replyToMode?: ReplyToMode;
    formatting?: OutboundDeliveryFormattingOptions;
    bestEffort?: boolean;
    gifPlayback?: boolean;
    forceDocument?: boolean;
    silent?: boolean;
    mirror?: OutboundMirror;
    /** Session context needed to preserve outbound media policy on recovery. */
    session?: OutboundSessionContext;
    /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
    gatewayClientScopes?: readonly string[];
};
export interface QueuedDelivery extends QueuedDeliveryPayload {
    id: string;
    enqueuedAt: number;
    retryCount: number;
    lastAttemptAt?: number;
    lastError?: string;
}
export declare function resolveQueueDir(stateDir?: string): string;
/** Ensure the queue directory (and failed/ subdirectory) exist. */
export declare function ensureQueueDir(stateDir?: string): Promise<string>;
/** Persist a delivery entry to disk before attempting send. Returns the entry ID. */
export declare function enqueueDelivery(params: QueuedDeliveryPayload, stateDir?: string): Promise<string>;
/** Remove a successfully delivered entry from the queue.
 *
 * Uses a two-phase approach so that a crash between delivery and cleanup
 * does not cause the message to be replayed on the next recovery scan:
 *   Phase 1: atomic rename  {id}.json → {id}.delivered
 *   Phase 2: unlink the .delivered marker
 * If the process dies between phase 1 and phase 2 the marker is cleaned up
 * by {@link loadPendingDeliveries} on the next startup without re-sending.
 */
export declare function ackDelivery(id: string, stateDir?: string): Promise<void>;
/** Update a queue entry after a failed delivery attempt. */
export declare function failDelivery(id: string, error: string, stateDir?: string): Promise<void>;
/** Load a single pending delivery entry by ID from the queue directory. */
export declare function loadPendingDelivery(id: string, stateDir?: string): Promise<QueuedDelivery | null>;
/** Load all pending delivery entries from the queue directory. */
export declare function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]>;
/** Move a queue entry to the failed/ subdirectory. */
export declare function moveToFailed(id: string, stateDir?: string): Promise<void>;
