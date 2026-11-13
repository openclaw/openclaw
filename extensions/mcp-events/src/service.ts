import { randomUUID } from "node:crypto";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";
import { preflightCallbackOrigin, resolveMcpEventSourceOptions } from "./config.js";
import { McpEventsIngress } from "./ingress.js";
import {
  CALLBACK_PREFIX,
  advertisesEvents,
  createSigningSecret,
  parseEventCatalog,
  parsePollResult,
  parseSubscriptionResult,
  type DeliveryMode,
  type EventDefinition,
} from "./protocol.js";
import {
  McpEventsSourceAuthority,
  SourceRevokedError,
  isAuthorityUnavailable,
  type SourceBinding,
} from "./source-authority.js";
import { createMcpEventsState, type McpEventsState, type SubscriptionBinding } from "./state.js";
import type { EventSourceSnapshot, McpEventsDependencies } from "./types.js";

export type LiveBinding = SourceBinding & {
  pending?: Promise<void>;
  writes: Promise<void>;
};
const REQUEST_TTL_MS = 60 * 60_000;
const ROTATION_WINDOW_MS = 5 * 60_000;
const MAX_CLEANUP_RETRIES = 8;
const MAX_POLL_EVENTS = 100;
// SEP-3415 NotFound and Unsupported: the event type changed, so rediscover it and start again.
const REDISCOVER_ERROR_CODES = new Set([-32023, -32026]);

export class McpEventsService {
  readonly ingress = new McpEventsIngress(this);
  readonly state: McpEventsState;
  readonly authority: McpEventsSourceAuthority;
  readonly bindings = new Map<string, LiveBinding>();
  readonly signal: AbortSignal;
  private readonly scheduled = new Map<
    string,
    ReturnType<McpEventsDependencies["scheduler"]["schedule"]>
  >();
  private readonly work = new Set<Promise<unknown>>();
  initialization: "restoring" | "reconciling" | "ready" = "restoring";
  private reconcileWork?: Promise<void>;
  private reconcileRequested = false;
  readonly unavailable = new Map<string, { source: EventSourceSnapshot; attempts: number }>();
  /** Consecutive NotFound/Unsupported poll replies per job; backs off the replacement's first poll. */
  private readonly rediscoveries = new Map<string, number>();

  constructor(readonly deps: McpEventsDependencies) {
    this.state = createMcpEventsState(deps.runtime);
    this.authority = new McpEventsSourceAuthority(deps.prepareSource, this.assertService);
    this.signal = deps.scheduler.signal;
  }

  get now() {
    return this.deps.scheduler.now();
  }
  assertService = () => {
    if (this.signal.aborted) {
      throw new SourceRevokedError("MCP Events service stopped");
    }
  };
  track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise);
    void promise.finally(() => this.work.delete(promise)).catch(() => {});
    return promise;
  }
  schedule(id: string, atMs: number, run: () => Promise<unknown>, earliest = false) {
    if (this.signal.aborted) {
      return;
    }
    this.scheduled.set(
      id,
      this.deps.scheduler.schedule({
        id,
        atMs,
        mode: earliest ? "earliest" : "replace",
        run: async () => {
          this.scheduled.delete(id);
          await this.track(run());
        },
      }),
    );
  }

  private cancelScheduled(id: string) {
    this.scheduled.get(id)?.cancel();
    this.scheduled.delete(id);
  }

  /** Draft facts commit only after serialized storage; callbacks can verify during subscribe. */
  mutate(
    binding: LiveBinding,
    update: (facts: SubscriptionBinding) => void,
    assertCurrent = this.authority.guard(binding),
  ) {
    const write = binding.writes.then(async () => {
      assertCurrent();
      const next = { ...binding.facts };
      update(next);
      next.updatedAt = this.now;
      await this.state.withCurrent({ assertCurrent }).register(next.bindingId, next);
      // A committed update stays recorded even if authority was revoked after commit admission.
      binding.facts = next;
    });
    binding.writes = write.catch(() => {});
    return write;
  }

  /** SEP-3415 client preference: webhook when a callback is configured and offered, else poll. */
  private deliveryFor(definition: EventDefinition): DeliveryMode | undefined {
    const offered = definition.delivery ?? ["webhook"];
    if (this.deps.config.callbackOrigin && offered.includes("webhook")) {
      return "webhook";
    }
    return offered.includes("poll") ? "poll" : undefined;
  }

  /** A binding whose delivery no longer matches the configuration is replaced, not migrated. */
  private isStale(facts: SubscriptionBinding): boolean {
    const delivery = this.deliveryFor(facts.definition);
    return facts.callbackUrl === undefined
      ? delivery !== "poll"
      : delivery !== "webhook" ||
          !facts.callbackUrl.startsWith(this.deps.config.callbackOrigin + CALLBACK_PREFIX);
  }

  async start(): Promise<void> {
    if (this.deps.config.callbackOrigin) {
      await preflightCallbackOrigin(this.deps.config.callbackOrigin, this.signal);
    }
    this.assertService();
    for (const { value: facts } of await this.state.bindings.entries()) {
      if (facts.status === "revoked" && !facts.cleanupPending) {
        await this.state.withCurrent({ assertCurrent: this.assertService }).delete(facts.bindingId);
        continue;
      }
      this.bindings.set(facts.bindingId, {
        facts,
        live: facts.status !== "revoked",
        writes: Promise.resolve(),
      });
      this.ingress.account(facts.accountId);
    }
    this.initialization = "reconciling";
    await this.reconcile();
    this.ingress.requestDrain();
  }

  async stop(): Promise<void> {
    this.deps.scheduler.beginClose();
    this.scheduled.clear();
    // Ordinary restart retains subscriptions and cursors. It is not a user unsubscribe.
    for (const binding of this.bindings.values()) {
      binding.live = false;
    }
    await Promise.allSettled(this.work);
    await Promise.all([...this.bindings.values()].map((binding) => binding.writes));
    await this.ingress.stop();
    for (const binding of this.bindings.values()) {
      binding.source?.dispose();
    }
  }

  requestReconcile() {
    if (this.signal.aborted) {
      return;
    }
    if (this.initialization === "restoring" || this.reconcileWork) {
      this.reconcileRequested = true;
      return;
    }
    this.schedule("reconcile", this.now, () => this.reconcile(), true);
  }

  reconcile(): Promise<void> {
    if (this.initialization === "restoring") {
      return Promise.reject(new Error("MCP Events subscription state is still restoring"));
    }
    if (this.reconcileWork) {
      return this.reconcileWork;
    }
    const run = this.reconcileSources();
    this.reconcileWork = run;
    void run
      .finally(() => {
        this.reconcileWork = undefined;
        if (this.reconcileRequested) {
          this.reconcileRequested = false;
          this.requestReconcile();
        }
      })
      .catch(() => {});
    return this.track(run);
  }

  private async reconcileSources() {
    const sources = await this.deps.cron.readEventSources();
    this.assertService();
    // Persisted bindings and Cron authority are now admitted; subscribe may verify before returning.
    this.initialization = "ready";
    const desired = new Map(
      sources.filter((source) => source.enabled).map((source) => [source.jobId, source]),
    );
    for (const binding of this.bindings.values()) {
      const source = desired.get(binding.facts.jobId);
      if (
        !source ||
        source.sourceIdentity !== binding.facts.sourceIdentity ||
        this.isStale(binding.facts)
      ) {
        await this.revoke(binding);
      }
    }
    for (const [jobId, failed] of this.unavailable) {
      if (desired.get(jobId)?.sourceIdentity !== failed.source.sourceIdentity) {
        this.unavailable.delete(jobId);
        this.cancelScheduled("source:" + jobId);
      }
    }
    const started: Promise<void>[] = [];
    for (const source of desired.values()) {
      this.assertService();
      let binding = [...this.bindings.values()].find(
        (entry) =>
          entry.live &&
          entry.facts.jobId === source.jobId &&
          entry.facts.sourceIdentity === source.sourceIdentity,
      );
      try {
        if (!binding) {
          binding = await this.createBinding(source);
        } else {
          await this.authority.refresh(binding);
        }
        this.unavailable.delete(source.jobId);
        // A poll binding's next poll is in memory only (nextPollMs); reconciliation keeps it.
        const pollArmed =
          binding.facts.callbackUrl === undefined &&
          this.scheduled.has("refresh:" + binding.facts.bindingId);
        if (binding.pending || pollArmed) {
          continue;
        }
        if (binding.facts.nextAttemptAt <= this.now) {
          started.push(this.begin(binding, this.renew.bind(this, binding)));
        } else {
          this.armRefresh(binding);
        }
      } catch (error) {
        if (binding && !isAuthorityUnavailable(error)) {
          await this.revoke(binding, "source_unavailable");
        }
        this.retrySource(source);
      }
    }
    await Promise.allSettled(started);
    this.ingress.requestDrain();
    for (const binding of this.bindings.values()) {
      if (
        !binding.live &&
        binding.facts.cleanupPending &&
        binding.facts.nextAttemptAt <= this.now &&
        !binding.pending
      ) {
        await this.beginCleanup(binding);
      } else if (!binding.live) {
        this.armCleanup(binding);
      }
    }
  }

  private retrySource(source: EventSourceSnapshot) {
    const previous = this.unavailable.get(source.jobId);
    const attempts =
      previous?.source.sourceIdentity === source.sourceIdentity ? previous.attempts + 1 : 1;
    this.unavailable.set(source.jobId, { source, attempts });
    this.deps.logger.warn(
      "mcp-events: source unavailable; check MCP account, event filters, and callback reachability",
    );
    // Enabled sources remain desired. Only retired subscription cleanup has a finite retry budget.
    this.schedule(
      "source:" + source.jobId,
      this.now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 9)),
      async () => {
        if (this.unavailable.get(source.jobId)?.source !== source) {
          return;
        }
        try {
          // Reconciliation alone creates bindings; retries must not race it into a second subscription.
          await this.reconcile();
        } catch {
          if (!this.signal.aborted) {
            this.retrySource(source);
          }
        }
      },
    );
  }

  /** One wake per binding: a webhook lease refresh, or the next poll. */
  private armRefresh(binding: LiveBinding, atMs = binding.facts.nextAttemptAt) {
    this.schedule("refresh:" + binding.facts.bindingId, atMs, async () => {
      if (binding.live && !binding.pending) {
        await this.begin(binding, this.renew.bind(this, binding));
      }
    });
  }

  private renew(binding: LiveBinding) {
    return binding.facts.callbackUrl === undefined ? this.poll(binding) : this.refresh(binding);
  }

  private async createBinding(snapshot: EventSourceSnapshot): Promise<LiveBinding> {
    const options = resolveMcpEventSourceOptions(snapshot.options);
    const source = await this.deps.prepareSource({ ...snapshot, serverName: options.serverName });
    try {
      const discovered = await source.request("server/discover", {}, this.signal);
      source.assertCurrent();
      if (!advertisesEvents(discovered)) {
        throw new Error("Configured MCP server does not advertise MCP 2.0 events");
      }
      let cursor: string | undefined;
      const seen = new Set<string>();
      let definition;
      for (let page = 0; page < 100; page++) {
        const catalog = parseEventCatalog(
          await source.request("events/list", cursor ? { cursor } : {}, this.signal),
        );
        source.assertCurrent();
        definition = catalog.events.find((event) => event.name === options.name);
        if (definition || !catalog.nextCursor) {
          break;
        }
        if (seen.has(catalog.nextCursor)) {
          throw new Error("MCP event catalog cursor repeated");
        }
        seen.add(catalog.nextCursor);
        cursor = catalog.nextCursor;
      }
      if (
        !definition ||
        !validateJsonSchemaValue({ schema: definition.inputSchema, value: options.arguments }).ok
      ) {
        throw new Error("MCP event or subscription arguments are unavailable");
      }
      const delivery = this.deliveryFor(definition);
      if (!delivery) {
        throw new Error(
          "MCP event is offered only by webhook; configure mcp-events.callbackOrigin to receive it",
        );
      }
      // A server that lists the event but keeps refusing its poll must not cause a rebind loop.
      const rediscovered = this.rediscoveries.get(snapshot.jobId) ?? 0;
      const rediscoveryDelay =
        delivery === "poll" && rediscovered > 0
          ? Math.min(300_000, 1_000 * 2 ** Math.min(rediscovered, 8))
          : 0;
      this.assertService();
      source.assertCurrent();
      const bindingId = randomUUID();
      const facts: SubscriptionBinding = {
        version: 1,
        bindingId,
        jobId: snapshot.jobId,
        sourceIdentity: snapshot.sourceIdentity,
        serverName: options.serverName,
        accountId: source.accountId,
        principalId: source.principalId,
        arguments: options.arguments,
        definition,
        ...(delivery === "webhook"
          ? {
              callbackUrl: this.deps.config.callbackOrigin + CALLBACK_PREFIX + bindingId,
              secret: createSigningSecret(),
            }
          : {}),
        status: "pending",
        cursor: null,
        cursorRevision: 0,
        truncated: false,
        nextAttemptAt: this.now + rediscoveryDelay,
        failures: 0,
        cleanupPending: false,
        updatedAt: this.now,
      };
      const binding: LiveBinding = { facts, source, live: true, writes: Promise.resolve() };
      // The pending callback secret must be durable and routable before subscribe starts.
      await this.state
        .withCurrent({ assertCurrent: this.authority.guard(binding) })
        .register(bindingId, facts);
      this.authority.guard(binding)();
      this.bindings.set(bindingId, binding);
      this.ingress.account(facts.accountId);
      return binding;
    } catch (error) {
      source.dispose();
      throw error;
    }
  }

  private begin(binding: LiveBinding, run: () => Promise<void>) {
    if (binding.pending) {
      return binding.pending;
    }
    const pending = run();
    binding.pending = pending;
    this.track(pending).catch(() =>
      this.deps.logger.warn("mcp-events: subscription state unavailable; retry remains pending"),
    );
    void pending
      .finally(() => {
        binding.pending = undefined;
      })
      .catch(() => {});
    return pending;
  }

  private async refresh(binding: LiveBinding) {
    let retryAt: number | undefined;
    try {
      await this.authority.refresh(binding);
      const source = binding.source!;
      const guard = this.authority.guard(binding);
      if (binding.facts.status === "active" && !binding.facts.pendingSecret) {
        await this.mutate(binding, (facts) => {
          facts.pendingSecret = createSigningSecret();
        });
      }
      const secret = binding.facts.pendingSecret ?? binding.facts.secret;
      if (!secret) {
        throw new Error("MCP Events webhook binding has no signing secret");
      }
      const cursorRevision = binding.facts.cursorRevision;
      guard();
      const response = await source.request(
        "events/subscribe",
        {
          name: binding.facts.definition.name,
          arguments: binding.facts.arguments,
          delivery: { mode: "webhook", url: binding.facts.callbackUrl, secret },
          cursor: binding.facts.cursor,
          ttlMs: REQUEST_TTL_MS,
        },
        this.signal,
      );
      guard();
      const result = parseSubscriptionResult(response, this.now);
      await this.mutate(binding, (facts) => {
        facts.status = "active";
        facts.remoteId = result.id;
        facts.refreshBefore = result.refreshBefore;
        if (facts.secret && facts.secret !== secret) {
          facts.previousSecret = { value: facts.secret, until: this.now + ROTATION_WINDOW_MS };
        }
        facts.secret = secret;
        delete facts.pendingSecret;
        facts.cursor = facts.cursorRevision === cursorRevision ? result.cursor : facts.cursor;
        facts.truncated ||= result.truncated;
        facts.failures = 0;
        delete facts.lastError;
        facts.nextAttemptAt =
          this.now + Math.max(1, Math.floor((result.refreshBefore - this.now) * 0.8));
      });
    } catch (error) {
      await this.recordFailure(binding, error, "subscribe_failed", (atMs) => {
        retryAt = atMs;
      });
    } finally {
      // A failed bookkeeping write must not consume the only recovery wakeup.
      if (binding.live) {
        this.armRefresh(binding, retryAt);
      }
    }
  }

  /**
   * SEP-3415 poll: one events/poll per wake, queued through the same ingress as webhook
   * callbacks. The cursor is persisted only after the batch is queued, so a crash re-polls
   * the batch and the queue drops the repeats by event ID.
   */
  private async poll(binding: LiveBinding) {
    let nextPollAt: number | undefined;
    try {
      await this.authority.refresh(binding);
      const source = binding.source!;
      const guard = this.authority.guard(binding);
      const result = parsePollResult(
        await source.request(
          "events/poll",
          {
            name: binding.facts.definition.name,
            arguments: binding.facts.arguments,
            cursor: binding.facts.cursor,
            maxEvents: MAX_POLL_EVENTS,
          },
          this.signal,
        ),
        binding.facts.definition,
      );
      guard();
      if (result.rejected > 0) {
        this.deps.logger.warn(
          "mcp-events: skipped " +
            result.rejected +
            " polled events that failed envelope or payloadSchema validation",
        );
      }
      if (result.truncated) {
        this.deps.logger.warn(
          "mcp-events: the server reports skipped events (truncated); check source state with tools",
        );
      }
      await this.ingress.admit(binding, result.events);
      const { facts } = binding;
      if (
        facts.status !== "active" ||
        facts.cursor !== result.cursor ||
        (result.truncated && !facts.truncated) ||
        facts.failures > 0
      ) {
        await this.mutate(binding, (next) => {
          next.status = "active";
          next.cursor = result.cursor;
          next.cursorRevision++;
          next.truncated ||= result.truncated;
          next.failures = 0;
          delete next.lastError;
          // A restart after recovery polls at once, not at the retired failure backoff.
          next.nextAttemptAt = this.now;
        });
      }
      this.rediscoveries.delete(binding.facts.jobId);
      nextPollAt = this.now + result.delayMs;
    } catch (error) {
      const code = record(error)?.code;
      if (typeof code === "number" && REDISCOVER_ERROR_CODES.has(code) && binding.live) {
        const { jobId } = binding.facts;
        this.rediscoveries.set(jobId, (this.rediscoveries.get(jobId) ?? 0) + 1);
        this.deps.logger.warn(
          "mcp-events: the server no longer accepts this poll (event type removed or changed); rediscovering it and restarting from now, so events in between are not replayed",
        );
        await this.revoke(binding, "source_unavailable");
        return;
      }
      await this.recordFailure(binding, error, "poll_failed", (atMs) => {
        nextPollAt = atMs;
      });
    } finally {
      if (binding.live) {
        this.armRefresh(binding, nextPollAt ?? this.now + 1_000);
      }
    }
  }

  /** Revokes a binding that lost authority; otherwise schedules a bounded retry and records it. */
  private async recordFailure(
    binding: LiveBinding,
    error: unknown,
    lastError: "subscribe_failed" | "poll_failed",
    retryAt: (atMs: number) => void,
  ) {
    if (!binding.live || this.signal.aborted) {
      return;
    }
    if (error instanceof SourceRevokedError) {
      await this.revoke(binding, "source_unavailable");
      return;
    }
    try {
      this.authority.guard(binding)();
    } catch (guardError) {
      if (!isAuthorityUnavailable(guardError)) {
        await this.revoke(binding, "source_unavailable");
        return;
      }
    }
    // Recording a failed authority observation is service bookkeeping, not authorized execution.
    const assertBindingCurrent = () => {
      this.assertService();
      if (!binding.live || this.bindings.get(binding.facts.bindingId) !== binding) {
        throw new SourceRevokedError("MCP event binding retired");
      }
    };
    const nextAttemptAt =
      this.now + Math.min(300_000, 1_000 * 2 ** Math.min(binding.facts.failures, 8));
    // Reported before the write: the caller's finally re-arms even if this bookkeeping fails.
    retryAt(nextAttemptAt);
    await this.mutate(
      binding,
      (facts) => {
        facts.failures++;
        facts.lastError = lastError;
        facts.nextAttemptAt = nextAttemptAt;
      },
      assertBindingCurrent,
    );
  }

  async revoke(binding: LiveBinding, reason?: SubscriptionBinding["lastError"]) {
    if (!binding.live && binding.facts.status === "revoked") {
      this.armCleanup(binding);
      return;
    }
    // Invalidate local authority before persistence, remote cleanup, or any other await.
    binding.live = false;
    this.cancelScheduled("refresh:" + binding.facts.bindingId);
    let retryAt = this.now;
    try {
      await this.mutate(
        binding,
        (facts) => {
          facts.status = "revoked";
          // Poll holds no server-side subscription, so there is nothing to unsubscribe.
          facts.cleanupPending = facts.callbackUrl !== undefined;
          facts.retiredAt = this.now;
          facts.failures = 0;
          if (reason === undefined) {
            delete facts.lastError;
          } else {
            facts.lastError = reason;
          }
          facts.nextAttemptAt = this.now;
        },
        this.assertService,
      );
    } catch (error) {
      retryAt = this.now + 1_000;
      throw error;
    } finally {
      // The local retirement owns recovery even when its durable write fails.
      this.armCleanup(binding, retryAt);
      if (reason === "source_unavailable") {
        this.requestReconcile();
      }
    }
  }

  private async forgetBinding(binding: LiveBinding) {
    const assertCurrent = () => {
      this.assertService();
      if (binding.live || this.bindings.get(binding.facts.bindingId) !== binding) {
        throw new SourceRevokedError("Subscription cleanup owner changed");
      }
    };
    await this.state.withCurrent({ assertCurrent }).delete(binding.facts.bindingId);
    this.cancelScheduled("cleanup:" + binding.facts.bindingId);
    binding.source?.dispose();
    binding.source = undefined;
    this.bindings.delete(binding.facts.bindingId);
  }

  private cleanupExpiry(binding: LiveBinding) {
    return (
      binding.facts.refreshBefore ??
      (binding.facts.retiredAt ?? binding.facts.updatedAt) + REQUEST_TTL_MS + ROTATION_WINDOW_MS
    );
  }

  private armCleanup(binding: LiveBinding, retryAt = this.now) {
    if (binding.live || this.bindings.get(binding.facts.bindingId) !== binding) {
      return;
    }
    const deadline =
      binding.facts.status === "revoked" &&
      binding.facts.cleanupPending &&
      binding.facts.failures >= MAX_CLEANUP_RETRIES
        ? this.cleanupExpiry(binding)
        : binding.facts.status === "revoked"
          ? binding.facts.nextAttemptAt
          : this.now;
    this.schedule("cleanup:" + binding.facts.bindingId, Math.max(retryAt, deadline), async () => {
      // A refresh in flight may still activate remotely; join it before cleanup.
      await binding.pending?.catch(() => {});
      if (
        !this.signal.aborted &&
        !binding.live &&
        this.bindings.get(binding.facts.bindingId) === binding
      ) {
        await this.beginCleanup(binding);
      }
    });
  }

  private beginCleanup(binding: LiveBinding) {
    return this.begin(binding, async () => {
      const retryAt =
        this.now + Math.min(300_000, 1_000 * 2 ** Math.min(binding.facts.failures, 8));
      try {
        if (binding.facts.status !== "revoked") {
          await this.revoke(binding);
        }
        if (!binding.facts.cleanupPending || binding.facts.failures >= MAX_CLEANUP_RETRIES) {
          if (!binding.facts.cleanupPending || this.now >= this.cleanupExpiry(binding)) {
            await this.forgetBinding(binding);
          }
          return;
        }
        if (!binding.source) {
          throw new Error("Original account authority unavailable after restart");
        }
        await binding.source.unsubscribe(this.signal);
        await this.mutate(
          binding,
          (facts) => {
            facts.cleanupPending = false;
            delete facts.lastError;
          },
          this.assertService,
        );
        await this.forgetBinding(binding);
      } catch {
        if (this.signal.aborted) {
          return;
        }
        await this.mutate(
          binding,
          (facts) => {
            facts.lastError = "cleanup_failed";
            facts.failures++;
            facts.nextAttemptAt = retryAt;
          },
          this.assertService,
        );
      } finally {
        // Neither failed bookkeeping nor deletion may consume the last cleanup wake.
        this.armCleanup(binding, retryAt);
      }
    });
  }
}
