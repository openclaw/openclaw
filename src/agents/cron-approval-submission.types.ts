import type { CronApprovedToolSelection } from "../cron/approved-tool-selection.js";

/**
 * Request-scoped host port. Plugins cannot select a broker or its destination.
 * The broker owns durable binding, expiry, and reconciliation. Its promise must
 * settle only after effects are terminal, including cancellation or a lost reply.
 * Aborting a transport alone does not discharge that obligation.
 */
export type CronApprovalSubmissionBroker = (submission: {
  proposal: Readonly<Record<string, unknown>>;
  selection?: CronApprovedToolSelection;
  signal: AbortSignal;
  /** Recheck in the synchronous durable-binding guard, after every awaited preparation. */
  assertCurrent: () => void;
  /** One-use original source; consume immediately before the host binds this proposal. */
  consume: () => void;
}) => Promise<unknown>;
