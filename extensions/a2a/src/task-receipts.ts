import { createHash } from "node:crypto";

/**
 * Authority store for A2A task reads.
 *
 * A read is authorized by a receipt created by a prior accepted `SendMessage`: it binds
 * the remote task ID to the sending agent/session incarnation and the configured peer.
 * The store is in-memory, bounded by TTL and entry count, and cleared when the account
 * stops. It is shared by the task action and the plain outbound send surfaces so that
 * every accepted send reconciles the same map.
 */
export type TaskReceipt = { source: string; contextId: string; createdAt: number };

const receipts = new Map<string, TaskReceipt>();
const MAX_RECEIPTS = 500;
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Bound on the peer-supplied conversation context retained with a receipt. The value
 * comes from the remote task, so an unbounded copy would let one peer pin memory far
 * beyond the entry count cap; an over-long or non-printable value simply stores no
 * receipt, which fails the later read closed.
 */
const MAX_CONTEXT_ID_BYTES = 512;
let receiptGeneration = 0;

function isStorableContextId(value: string | undefined | null): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_ID_BYTES &&
    /^[\x20-\x7e]+$/.test(value)
  );
}

/**
 * Scope of one configured peer outbound target. Rotation or retargeting invalidates
 * receipts; no credential is kept in the map.
 */
export function a2aPeerScope(parts: {
  accountId: string;
  peerName: string;
  url: string;
  outboundToken: string | null | undefined;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.accountId, parts.peerName, parts.url, parts.outboundToken ?? null]))
    .digest("hex");
}

function taskReceiptKey(peerScope: string, taskId: string): string {
  return createHash("sha256").update(JSON.stringify([peerScope, taskId])).digest("hex");
}

export function pruneTaskReceipts(): void {
  for (const [key, receipt] of receipts) {
    if (Date.now() - receipt.createdAt >= RECEIPT_TTL_MS || receipts.size > MAX_RECEIPTS) {
      receipts.delete(key);
    }
  }
}

export function clearA2aTaskReadReceipts(): void {
  receiptGeneration += 1;
  receipts.clear();
}

export function currentReceiptGeneration(): number {
  return receiptGeneration;
}

export function getTaskReceipt(peerScope: string, taskId: string): TaskReceipt | undefined {
  return receipts.get(taskReceiptKey(peerScope, taskId));
}

/**
 * Reconcile the store with one accepted send result.
 *
 * A peer may report a task ID it already used for another source, and every send to a
 * peer shares one remote conversation context (`ctx-oc-<peer>`), so an older receipt
 * would still satisfy the source-independent context check. Any accepted send that
 * cannot install a safe replacement therefore revokes any existing entry for that task
 * ID instead of leaving read authority behind. The receipt-less send surfaces (the
 * direct channel adapter and CLI sends) call this with no session source and revoke.
 *
 * Returns whether a replacement receipt was installed.
 */
export function recordAcceptedSend(input: {
  peerScope: string;
  taskId: string | undefined;
  source: string | undefined;
  contextId: string | undefined;
  generation: number;
}): boolean {
  // An uncorrelated response or one without a task ID carries no key we could reconcile.
  if (!input.taskId) {
    return false;
  }
  const key = taskReceiptKey(input.peerScope, input.taskId);
  // Prune before the collision lookup: an entry that outlived its TTL must not block a
  // replacement receipt for the same task ID.
  pruneTaskReceipts();
  const previous = receipts.get(key);
  const source = input.source;
  const contextId = input.contextId;
  const collision = previous !== undefined && previous.source !== source;
  if (
    collision ||
    source === undefined ||
    input.generation !== receiptGeneration ||
    !isStorableContextId(contextId)
  ) {
    // Either this send can never mint a receipt (no session identity, a cleared store, or
    // an unstorable peer context), or the peer handed this task ID to a different source.
    // In both cases revoke instead of leaving — or creating — read authority.
    receipts.delete(key);
    return false;
  }
  receipts.set(key, { source, contextId, createdAt: Date.now() });
  pruneTaskReceipts();
  return true;
}
