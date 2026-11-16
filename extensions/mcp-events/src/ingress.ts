import { CHANNEL_INGRESS_RETENTION_DEFAULTS } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  CallbackError,
  MCP_EVENTS_POLL_PROFILE,
  MCP_EVENTS_PROFILE,
  identityHash,
  type ApplicationEvent,
} from "./protocol.js";
import type { LiveBinding, McpEventsService } from "./service.js";
import { SourceRevokedError, isAuthorityUnavailable } from "./source-authority.js";
import type { McpEventsState, QueuedEvent } from "./state.js";

type Queue = ReturnType<McpEventsState["openQueue"]>;
type Drain = ReturnType<OpenClawPluginApi["runtime"]["state"]["openChannelIngressDrain"]>;
type AccountQueue = {
  queue: Queue;
  drain: Drain;
  admission: Promise<void>;
  lastPrunedAt?: number;
  lastReceivedAt?: number;
};
const DRAIN_RETRY_MS = 1_000;

/** Per-account durable ingress queues and their drain into the Cron execution owner. */
export class McpEventsIngress {
  private readonly accounts = new Map<string, AccountQueue>();
  private drainWork?: Promise<void>;
  private drainRetryMs = DRAIN_RETRY_MS;

  constructor(private readonly service: McpEventsService) {}

  async stop(): Promise<void> {
    for (const account of this.accounts.values()) {
      await account.admission;
      await account.drain.waitForIdle();
      account.drain.dispose();
    }
  }

  /**
   * Durable ingress shared by webhook callbacks and poll results. Each event becomes one queued
   * claim that the drain hands to the Cron owner, which runs the Automation once per event.
   */
  async admit(binding: LiveBinding, events: readonly ApplicationEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const guard = this.service.authority.guard(binding);
    const webhook = binding.facts.callbackUrl !== undefined;
    const account = this.account(binding.facts.accountId);
    const admission = account.admission.then(async () => {
      guard();
      const unsettled = await account.queue.listUnsettled!();
      guard();
      const queued = new Set([...unsettled.pending, ...unsettled.claims].map((row) => row.id));
      let cursor: string | null | undefined;
      for (const event of events) {
        const id = identityHash([binding.facts.accountId, binding.facts.bindingId, event.eventId]);
        if (!queued.has(id) && queued.size >= this.service.deps.config.maxPendingEvents) {
          throw new CallbackError(503, "Event queue is full; retry later");
        }
        // Lanes drain by receipt time, then ID. Distinct times keep a poll batch in server order;
        // the counter is in memory, so order across a restart rests on the clock moving forward.
        const receivedAt = Math.max(this.service.now, (account.lastReceivedAt ?? 0) + 1);
        account.lastReceivedAt = receivedAt;
        const result = await account.queue.enqueueAuthorized!(
          id,
          {
            jobId: binding.facts.jobId,
            sourceIdentity: binding.facts.sourceIdentity,
            eventId: event.eventId,
            receivedAtMs: receivedAt,
            payload: {
              profile: webhook ? MCP_EVENTS_PROFILE : MCP_EVENTS_POLL_PROFILE,
              bindingId: binding.facts.bindingId,
              event,
            },
          },
          { laneKey: binding.facts.jobId, receivedAt, assertCurrent: guard },
        );
        guard();
        if (result.kind === "failed") {
          throw new CallbackError(
            503,
            "Event is retained for recovery; inspect ingress diagnostics",
          );
        }
        if (result.kind === "accepted") {
          queued.add(id);
        }
        if (result.kind === "accepted" || result.kind === "pending" || result.kind === "claimed") {
          cursor = result.record.payload.payload.event.cursor;
        }
      }
      // Persist only after durable ingress. Cursors are opaque upstream watermarks, not event
      // sequence IDs. A poll result carries one cursor for its batch, which poll() persists.
      if (webhook && cursor !== undefined) {
        await this.service.mutate(binding, (facts) => {
          facts.cursor = cursor;
          facts.cursorRevision++;
        });
      }
      guard();
    });
    account.admission = admission.catch(() => {});
    try {
      await this.service.track(admission);
    } finally {
      // A cursor write can fail after durable enqueue; committed work must still be woken.
      this.requestDrain();
    }
  }

  account(accountId: string): AccountQueue {
    const existing = this.accounts.get(accountId);
    if (existing) {
      return existing;
    }
    const queue = this.service.state.openQueue(accountId);
    if (!queue.listUnsettled || !queue.enqueueAuthorized) {
      throw new Error("MCP Events requires coherent durable ingress inspection; update OpenClaw");
    }
    const drain = this.service.deps.runtime.state.openChannelIngressDrain<QueuedEvent>({
      queue,
      abortSignal: this.service.signal,
      now: () => this.service.now,
      deriveLaneKey: (event) => event.payload.jobId,
      startLimit: 8,
      formatError: () => "MCP event admission failed; inspect source and automation diagnostics",
      onLog: (message) => this.service.deps.logger.warn(message),
      resolveNonRetryableFailure: (error) =>
        error instanceof SourceRevokedError
          ? {
              reason: "source_revoked",
              message: "The authored event source was removed, paused, or replaced",
            }
          : null,
      dispatchClaimedEvent: async (claim) => {
        const binding = this.service.bindings.get(claim.payload.payload.bindingId);
        if (!binding?.live) {
          throw new SourceRevokedError("MCP event source revoked");
        }
        try {
          await this.service.authority.refresh(binding);
          const assertCurrent = this.service.authority.guard(binding);
          assertCurrent();
          const { jobId, ...input } = claim.payload;
          const result = await this.service.deps.cron.runEvent(jobId, {
            ...input,
            claim: { queueName: claim.queueName, id: claim.id, token: claim.claim.token },
            assertCurrent,
          });
          if (result.kind === "invalidated") {
            throw new SourceRevokedError("MCP event source changed");
          }
          if (result.kind === "pending") {
            return { kind: "pending" };
          }
          // The Cron owner atomically consumed this exact claim with its receipt. No second completion.
          return { kind: "transferred" };
        } catch (error) {
          if (isAuthorityUnavailable(error)) {
            return { kind: "pending" };
          }
          if (error instanceof SourceRevokedError) {
            await this.service.revoke(binding, "source_unavailable");
          }
          throw error;
        }
      },
    });
    const account = { queue, drain, admission: Promise.resolve() };
    this.accounts.set(accountId, account);
    return account;
  }

  /** Hooks and durable enqueue wake the existing host scheduler; empty queues have no timer. */
  requestDrain(jobId?: string) {
    if (
      this.service.signal.aborted ||
      (jobId &&
        ![...this.service.bindings.values()].some((binding) => binding.facts.jobId === jobId))
    ) {
      return;
    }
    this.drainRetryMs = DRAIN_RETRY_MS;
    this.service.schedule("drain", this.service.now, () => this.drain(), true);
  }

  private drain(): Promise<void> {
    if (this.drainWork) {
      return this.drainWork;
    }
    const operation = (async () => {
      let backlog = false;
      try {
        for (const account of this.accounts.values()) {
          this.service.assertService();
          await account.drain.recoverStaleClaims();
          await account.drain.drainOnce();
          await account.drain.waitForIdle();
          if (
            account.lastPrunedAt === undefined ||
            this.service.now - account.lastPrunedAt >=
              CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs
          ) {
            const { pruneIntervalMs: _interval, ...retention } = CHANNEL_INGRESS_RETENTION_DEFAULTS;
            // Pending and claimed rows have no retention eviction.
            await account.queue.prune({ ...retention, now: this.service.now });
            account.lastPrunedAt = this.service.now;
          }
          const unsettled = await account.queue.listUnsettled!();
          backlog ||= unsettled.pending.length > 0 || unsettled.claims.length > 0;
        }
      } catch {
        backlog = true;
        this.service.deps.logger.warn(
          "mcp-events: ingress inspection/admission unavailable; retained work will retry",
        );
      } finally {
        if (backlog && !this.service.signal.aborted) {
          this.service.schedule(
            "drain",
            this.service.now + this.drainRetryMs,
            () => this.drain(),
            true,
          );
          this.drainRetryMs = Math.min(30_000, this.drainRetryMs * 2);
        }
      }
    })();
    this.drainWork = operation;
    void operation
      .finally(() => {
        this.drainWork = undefined;
      })
      .catch(() => {});
    return this.service.track(operation);
  }
}
