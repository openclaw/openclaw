import type { IncomingHttpHeaders } from "node:http";
import { CHANNEL_INGRESS_RETENTION_DEFAULTS } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  CallbackError,
  MCP_EVENTS_PROFILE,
  identityHash,
  parseCallback,
  verifyWebhook,
} from "./protocol.js";
import { SourceRevokedError, isAuthorityUnavailable } from "./source-authority.js";
import type { McpEventsState, QueuedEvent, SubscriptionBinding } from "./state.js";
import type { McpEventsDependencies } from "./types.js";

type BindingAuthority = {
  readonly facts: Readonly<SubscriptionBinding>;
  readonly live: boolean;
  readonly pending?: Promise<void>;
};
type IngressOwner<TBinding extends BindingAuthority> = {
  signal: AbortSignal;
  assertService: () => void;
  isStopped: () => boolean;
  binding: (id: string) => TBinding | undefined;
  hasJob: (jobId: string) => boolean;
  refreshAuthority: (binding: TBinding) => Promise<void>;
  guard: (binding: TBinding) => () => void;
  revoke: (binding: TBinding) => Promise<void>;
  persistCursor: (binding: TBinding, cursor: string | null) => Promise<void>;
  track: <T>(promise: Promise<T>) => Promise<T>;
  schedule: (id: string, atMs: number, run: () => Promise<unknown>, earliest?: boolean) => void;
};
type Queue = ReturnType<McpEventsState["openQueue"]>;
type Drain = ReturnType<OpenClawPluginApi["runtime"]["state"]["openChannelIngressDrain"]>;
type AccountQueue = { queue: Queue; drain: Drain; admission: Promise<void>; lastPrunedAt?: number };
const DRAIN_RETRY_MS = 1_000;

/** Adapts authenticated callbacks to the existing account queue and Cron admission owners. */
export class McpEventsIngress<TBinding extends BindingAuthority> {
  private readonly accounts = new Map<string, AccountQueue>();
  private drainWork?: Promise<void>;
  private drainRetryMs = DRAIN_RETRY_MS;

  constructor(
    private readonly deps: Pick<
      McpEventsDependencies,
      "runtime" | "config" | "scheduler" | "cron" | "logger"
    >,
    private readonly openQueue: McpEventsState["openQueue"],
    private readonly owner: IngressOwner<TBinding>,
  ) {}

  private get now() {
    return this.deps.scheduler.now();
  }

  async stop(): Promise<void> {
    for (const account of this.accounts.values()) {
      await account.admission;
      await account.drain.waitForIdle();
      account.drain.dispose();
    }
  }

  account(accountId: string): AccountQueue {
    const existing = this.accounts.get(accountId);
    if (existing) {
      return existing;
    }
    const queue = this.openQueue(accountId);
    if (!queue.listUnsettled || !queue.enqueueAuthorized) {
      throw new Error("MCP Events requires coherent durable ingress inspection; update OpenClaw");
    }
    const drain = this.deps.runtime.state.openChannelIngressDrain<QueuedEvent>({
      queue,
      abortSignal: this.owner.signal,
      now: () => this.now,
      deriveLaneKey: (event) => event.payload.jobId,
      startLimit: 8,
      formatError: () => "MCP event admission failed; inspect source and automation diagnostics",
      onLog: (message) => this.deps.logger.warn(message),
      resolveNonRetryableFailure: (error) =>
        error instanceof SourceRevokedError
          ? {
              reason: "source_revoked",
              message: "The authored event source was removed, paused, or replaced",
            }
          : null,
      dispatchClaimedEvent: async (claim) => {
        const binding = this.owner.binding(claim.payload.payload.bindingId);
        if (!binding?.live) {
          throw new SourceRevokedError("MCP event source revoked");
        }
        try {
          await this.owner.refreshAuthority(binding);
          const assertCurrent = this.owner.guard(binding);
          assertCurrent();
          const { jobId, ...input } = claim.payload;
          const result = await this.deps.cron.runEvent(jobId, {
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
            await this.owner.revoke(binding);
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
    if (this.owner.isStopped() || (jobId && !this.owner.hasJob(jobId))) {
      return;
    }
    this.drainRetryMs = DRAIN_RETRY_MS;
    this.owner.schedule("drain", this.now, () => this.drain(), true);
  }

  private drain(): Promise<void> {
    if (this.drainWork) {
      return this.drainWork;
    }
    const operation = (async () => {
      let backlog = false;
      try {
        for (const account of this.accounts.values()) {
          this.owner.assertService();
          await account.drain.recoverStaleClaims();
          await account.drain.drainOnce();
          await account.drain.waitForIdle();
          if (
            account.lastPrunedAt === undefined ||
            this.now - account.lastPrunedAt >= CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs
          ) {
            const { pruneIntervalMs: _interval, ...retention } = CHANNEL_INGRESS_RETENTION_DEFAULTS;
            // Pending and claimed rows have no retention eviction.
            await account.queue.prune({ ...retention, now: this.now });
            account.lastPrunedAt = this.now;
          }
          const unsettled = await account.queue.listUnsettled!();
          backlog ||= unsettled.pending.length > 0 || unsettled.claims.length > 0;
        }
      } catch {
        backlog = true;
        this.deps.logger.warn(
          "mcp-events: ingress inspection/admission unavailable; retained work will retry",
        );
      } finally {
        if (backlog && !this.owner.isStopped()) {
          this.owner.schedule("drain", this.now + this.drainRetryMs, () => this.drain(), true);
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
    return this.owner.track(operation);
  }

  /** Called only after bounded raw-body admission by the registered HTTP route. */
  async receive(
    bindingId: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): Promise<{ challenge?: string }> {
    this.owner.assertService();
    const binding = this.owner.binding(bindingId);
    if (!binding?.live) {
      throw new CallbackError(410, "Subscription is no longer active");
    }
    try {
      await this.owner.refreshAuthority(binding);
    } catch (error) {
      if (isAuthorityUnavailable(error)) {
        throw new CallbackError(503, "Subscription authority is temporarily unavailable");
      }
      await this.owner.revoke(binding);
      throw new CallbackError(410, "Subscription source is no longer authorized");
    }
    const guard = this.owner.guard(binding);
    guard();
    const secrets = [
      binding.facts.secret,
      ...(binding.facts.pendingSecret ? [binding.facts.pendingSecret] : []),
      ...(binding.facts.previousSecret && binding.facts.previousSecret.until > this.now
        ? [binding.facts.previousSecret.value]
        : []),
    ];
    const webhookId = verifyWebhook({ headers, body, secrets, now: this.now });
    const parsed = parseCallback(body, webhookId, binding.facts.definition);
    if (parsed.kind === "verification") {
      guard();
      return { challenge: parsed.challenge };
    }
    if (binding.facts.status !== "active") {
      throw new CallbackError(503, "Subscription activation is pending");
    }
    if (!binding.facts.refreshBefore || binding.facts.refreshBefore <= this.now) {
      if (binding.pending || binding.facts.pendingSecret) {
        throw new CallbackError(503, "Subscription renewal is pending");
      }
      throw new CallbackError(410, "Subscription expired");
    }
    const account = this.account(binding.facts.accountId);
    const admission = account.admission.then(async () => {
      guard();
      const id = identityHash([binding.facts.accountId, bindingId, parsed.event.eventId]);
      const unsettled = await account.queue.listUnsettled!();
      guard();
      const duplicate =
        unsettled.pending.some((row) => row.id === id) ||
        unsettled.claims.some((row) => row.id === id);
      if (
        !duplicate &&
        unsettled.pending.length + unsettled.claims.length >= this.deps.config.maxPendingEvents
      ) {
        throw new CallbackError(503, "Event queue is full; retry later");
      }
      const result = await account.queue.enqueueAuthorized!(
        id,
        {
          jobId: binding.facts.jobId,
          sourceIdentity: binding.facts.sourceIdentity,
          eventId: parsed.event.eventId,
          receivedAtMs: this.now,
          payload: { profile: MCP_EVENTS_PROFILE, bindingId, event: parsed.event },
        },
        { laneKey: binding.facts.jobId, receivedAt: this.now, assertCurrent: guard },
      );
      guard();
      if (result.kind === "failed") {
        throw new CallbackError(503, "Event is retained for recovery; inspect ingress diagnostics");
      }
      // Persist only after durable ingress. Cursors are opaque upstream watermarks, not event sequence IDs.
      if (result.kind === "accepted" || result.kind === "pending" || result.kind === "claimed") {
        await this.owner.persistCursor(binding, result.record.payload.payload.event.cursor);
      }
      guard();
    });
    account.admission = admission.catch(() => {});
    try {
      await this.owner.track(admission);
    } finally {
      // A cursor write can fail after durable enqueue; committed work must still be woken.
      this.requestDrain();
    }
    return {};
  }
}
