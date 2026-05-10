import crypto from "node:crypto";
import {
  codexSandboxPolicyForTurn,
  resolveCodexAppServerRuntimeOptions,
} from "../app-server/config.js";
import { getSharedCodexAppServerClient } from "../app-server/shared-client.js";
import { formatCodexDisplayText } from "../command-formatters.js";
import { readCodexThreadsFromAppServer, buildCapabilityMap } from "./app-server-reader.js";
import { type CodexContinuityBridgeConfig, resolveCodexContinuityBridgeConfig } from "./config.js";
import { buildCodexHandoffBrief } from "./handoff.js";
import {
  classifyCodexBridgeEvent,
  shouldNotifyWatch,
  validateCodexWriteRequest,
} from "./policy.js";
import { redactCodexBridgeText } from "./redaction.js";
import { readCodexThreadsFromSqlite } from "./sqlite-reader.js";
import type {
  CodexBridgeAuditEvent,
  CodexBridgeEventInput,
  CodexBridgeSnapshot,
  CodexBridgeWatchRecord,
  CodexBridgeWriteDecision,
  CodexBridgeWriteRequest,
} from "./types.js";

type KeyedStore<T> = {
  register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T; createdAt: number; expiresAt?: number }>>;
  delete(key: string): Promise<boolean>;
};

export type CodexContinuityBridgeDeps = {
  resolvePluginConfig: () => unknown;
  configForAppServer?: () => unknown;
  watchStore: KeyedStore<CodexBridgeWatchRecord>;
  eventStore: KeyedStore<CodexBridgeAuditEvent>;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
  };
  sendTelegram?: (params: {
    channel: string;
    target: string;
    text: string;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<void>;
  readAppServerThreads?: typeof readCodexThreadsFromAppServer;
  readSqliteThreads?: typeof readCodexThreadsFromSqlite;
};

const CODEX_CONTINUITY_GLOBAL = Symbol.for("openclaw.codex.continuityBridge");
const WATCH_STORE_TTL_BUFFER_MS = 7 * 24 * 60 * 60_000;
const EVENT_STORE_TTL_MS = 14 * 24 * 60 * 60_000;

export class CodexContinuityBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTelegramFailure: string | undefined;

  constructor(private readonly deps: CodexContinuityBridgeDeps) {}

  start(): void {
    const config = this.config();
    if (!config.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.checkWatches({ backfill: false }).catch((error) =>
        this.deps.logger?.warn?.("Codex continuity watch check failed", { error: String(error) }),
      );
    }, config.pollIntervalMs);
    this.timer.unref?.();
    void this.checkWatches({ backfill: true }).catch((error) =>
      this.deps.logger?.warn?.("Codex continuity backfill failed", { error: String(error) }),
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  config(): CodexContinuityBridgeConfig {
    return resolveCodexContinuityBridgeConfig(this.deps.resolvePluginConfig());
  }

  async snapshot(): Promise<CodexBridgeSnapshot> {
    const config = this.config();
    const appServer = await (this.deps.readAppServerThreads ?? readCodexThreadsFromAppServer)({
      pluginConfig: this.deps.resolvePluginConfig(),
      config: this.deps.configForAppServer?.(),
      limit: config.maxThreads,
      confirmedWriteMethods: config.confirmedWriteMethods,
    });
    const watches = await this.activeWatches();
    if (appServer.ok) {
      const threads = sortThreads(appServer.threads).slice(0, config.maxThreads);
      return {
        ok: true,
        source: "app-server",
        stale: false,
        observedAt: new Date().toISOString(),
        appServerStatus: { available: true, capabilities: appServer.capabilities },
        activeThreads: activeThreads(threads),
        latestThread: threads[0],
        threads,
        watches,
        ...(this.lastTelegramFailure ? { lastTelegramFailure: this.lastTelegramFailure } : {}),
        warnings: appServer.capabilities.warnings,
      };
    }

    const sqlite = await (this.deps.readSqliteThreads ?? readCodexThreadsFromSqlite)({
      sqliteStatePath: config.sqliteStatePath,
      limit: config.maxThreads,
    });
    const threads = sortThreads(sqlite.threads).slice(0, config.maxThreads);
    return {
      ok: sqlite.ok,
      source: "sqlite",
      stale: true,
      observedAt: new Date().toISOString(),
      appServerStatus: {
        available: false,
        error: appServer.error,
        capabilities: appServer.capabilities ?? buildCapabilityMap(config.confirmedWriteMethods),
      },
      activeThreads: activeThreads(threads),
      latestThread: threads[0],
      threads,
      watches,
      ...(this.lastTelegramFailure ? { lastTelegramFailure: this.lastTelegramFailure } : {}),
      warnings: [appServer.error, ...sqlite.warnings, ...(sqlite.ok ? [] : [sqlite.error])].filter(
        Boolean,
      ),
    };
  }

  async registerWatch(params: {
    threadId?: string;
    repoPath?: string;
    goalKey?: string;
    notifyTarget?: string;
    notifyChannel?: string;
    notifyAccountId?: string;
    notifyThreadId?: string | number;
    createdBy: string;
    sensitivity?: CodexBridgeWatchRecord["sensitivity"];
    verbosity?: CodexBridgeWatchRecord["verbosity"];
    ttlMs?: number;
  }): Promise<CodexBridgeWatchRecord> {
    const config = this.config();
    const scope = params.goalKey ? "goal" : params.repoPath && !params.threadId ? "repo" : "thread";
    const ttlMs = Math.min(params.ttlMs ?? config.watchTtlMs, 30 * 24 * 60 * 60_000);
    const now = Date.now();
    const watch = dropUndefined({
      version: 1,
      watchId: `watch_${crypto.randomUUID()}`,
      scope,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      ...(params.goalKey ? { goalKey: params.goalKey } : {}),
      notifyChannel: params.notifyChannel ?? config.notifyChannel,
      notifyTarget: params.notifyTarget ?? config.notifyTarget,
      ...(params.notifyAccountId ? { notifyAccountId: params.notifyAccountId } : {}),
      ...(params.notifyThreadId != null ? { notifyThreadId: params.notifyThreadId } : {}),
      policy: "explicit-watch",
      verbosity: params.verbosity ?? "blockers_and_completion",
      sensitivity: params.sensitivity ?? "normal",
      createdBy: params.createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    }) as CodexBridgeWatchRecord;
    await this.deps.watchStore.register(watch.watchId, watch, {
      ttlMs: ttlMs + WATCH_STORE_TTL_BUFFER_MS,
    });
    await this.recordAudit({
      eventType: "watch_registered",
      eventClass: "user_requested_watch_update",
      threadId: watch.threadId,
      goalKey: watch.goalKey,
      source: "bridge",
      summary: `Registered ${watch.scope} watch`,
      decision: "watch",
      reasons: ["explicit user watch"],
    });
    return watch;
  }

  async checkWatches(options: {
    backfill: boolean;
  }): Promise<{ notified: number; suppressed: number }> {
    const snapshot = await this.snapshot();
    let notified = 0;
    let suppressed = 0;
    for (const watch of snapshot.watches) {
      const event = eventForWatch(snapshot, watch);
      if (!event) {
        continue;
      }
      const eventClass = classifyCodexBridgeEvent(event);
      const decision = shouldNotifyWatch({ watch, event, eventClass });
      if (!decision.notify) {
        suppressed += 1;
        await this.recordAudit({
          eventType: "telegram_suppressed",
          eventClass,
          threadId: event.threadId,
          goalKey: event.goalKey,
          source: event.source ?? snapshot.source,
          summary: event.summary ?? `Suppressed ${eventClass}`,
          decision: "suppress",
          reasons: decision.reasons,
        });
        continue;
      }
      const text = formatWatchNotification({ watch, event, eventClass, delayed: options.backfill });
      const sent = await this.sendWatchNotification(watch, text);
      const updatedWatch = dropUndefined({
        ...watch,
        lastEventAt: new Date().toISOString(),
        lastNotifiedAt: sent ? new Date().toISOString() : watch.lastNotifiedAt,
        dedupeKeyLastSeen: decision.dedupeKey,
        lastStatus: event.status ?? watch.lastStatus,
      }) as CodexBridgeWatchRecord;
      await this.deps.watchStore.register(watch.watchId, updatedWatch, {
        ttlMs: Math.max(
          60_000,
          Date.parse(watch.expiresAt) - Date.now() + WATCH_STORE_TTL_BUFFER_MS,
        ),
      });
      notified += sent ? 1 : 0;
      await this.recordAudit({
        eventType: sent ? "telegram_notified" : "telegram_send_failed",
        eventClass,
        threadId: event.threadId,
        goalKey: event.goalKey,
        source: event.source ?? snapshot.source,
        summary: text,
        decision: sent ? "notify" : "suppress",
        reasons: sent
          ? decision.reasons
          : [...decision.reasons, this.lastTelegramFailure ?? "send failed"],
      });
    }
    return { notified, suppressed };
  }

  async handoff(threadId?: string): Promise<ReturnType<typeof buildCodexHandoffBrief>> {
    const brief = buildCodexHandoffBrief({ snapshot: await this.snapshot(), threadId });
    await this.recordAudit({
      eventType: "handoff_generated",
      eventClass: "user_requested_watch_update",
      threadId,
      source: "bridge",
      summary: "Generated Codex handoff brief",
      decision: "handoff",
      reasons: ["explicit handoff request"],
    });
    return brief;
  }

  async evaluateWriteRequest(request: CodexBridgeWriteRequest): Promise<CodexBridgeWriteDecision> {
    const snapshot = await this.snapshot();
    const decision = validateCodexWriteRequest({
      request,
      config: this.config(),
      threads: snapshot.threads,
    });
    if (!decision.ok) {
      await this.recordAudit({
        eventType: "write_rejected",
        eventClass: "safety_boundary",
        threadId: request.threadId,
        source: "bridge",
        summary: decision.message,
        decision: "reject",
        reasons: decision.reasons,
      });
    }
    return decision;
  }

  async submitWriteRequest(request: CodexBridgeWriteRequest): Promise<CodexBridgeWriteDecision> {
    const decision = await this.evaluateWriteRequest(request);
    if (!decision.ok) {
      return decision;
    }
    const config = this.config();
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: this.deps.resolvePluginConfig(),
    });
    const client = await getSharedCodexAppServerClient({
      startOptions: runtime.start,
      timeoutMs: runtime.requestTimeoutMs,
      config: this.deps.configForAppServer?.() as never,
    });
    if (request.action === "steer") {
      await client.request(
        "turn/steer",
        {
          threadId: decision.threadId!,
          expectedTurnId: request.turnId!,
          input: [{ type: "text", text: request.prompt, text_elements: [] }],
        },
        { timeoutMs: runtime.requestTimeoutMs },
      );
    } else {
      await client.request(
        "turn/start",
        {
          threadId: decision.threadId!,
          input: [{ type: "text", text: `/goal ${request.prompt}`, text_elements: [] }],
          ...(decision.repoPath ? { cwd: decision.repoPath } : {}),
          approvalPolicy: runtime.approvalPolicy,
          approvalsReviewer: runtime.approvalsReviewer,
          sandboxPolicy: codexSandboxPolicyForTurn(
            runtime.sandbox,
            decision.repoPath ?? process.cwd(),
          ),
          ...(runtime.serviceTier ? { serviceTier: runtime.serviceTier } : {}),
        },
        { timeoutMs: runtime.requestTimeoutMs },
      );
    }
    await this.recordAudit({
      eventType:
        request.action === "goal"
          ? "goal_submitted_from_telegram"
          : "steer_submitted_from_telegram",
      eventClass: "user_requested_watch_update",
      threadId: decision.threadId,
      source: "bridge",
      summary: redactCodexBridgeText(request.prompt, 500),
      decision: "notify",
      reasons: decision.reasons,
    });
    if (config.telegramDryRun) {
      return { ...decision, dryRun: true };
    }
    return decision;
  }

  async formatStatusCommand(): Promise<string> {
    const snapshot = await this.snapshot();
    const lines = [
      `Codex continuity: ${snapshot.ok ? "ready" : "degraded"} (${snapshot.source}${snapshot.stale ? ", stale" : ""})`,
      `App-server: ${snapshot.appServerStatus.available ? "connected" : `unavailable: ${formatCodexDisplayText(snapshot.appServerStatus.error ?? "unknown")}`}`,
      `Watches: ${snapshot.watches.length}`,
    ];
    if (snapshot.latestThread) {
      lines.push(`Latest: ${formatThreadLine(snapshot.latestThread)}`);
    }
    if (snapshot.activeThreads.length > 0) {
      lines.push("Active:");
      lines.push(
        ...snapshot.activeThreads.slice(0, 5).map((thread) => `- ${formatThreadLine(thread)}`),
      );
    } else {
      lines.push("Active: none observed");
    }
    if (snapshot.warnings.length > 0) {
      lines.push(
        `Warnings: ${snapshot.warnings.slice(0, 2).map(formatCodexDisplayText).join("; ")}`,
      );
    }
    return lines.join("\n");
  }

  async formatThreadsCommand(): Promise<string> {
    const snapshot = await this.snapshot();
    if (snapshot.threads.length === 0) {
      return `No Codex threads observed (${snapshot.source}${snapshot.stale ? ", stale" : ""}).`;
    }
    return [
      `Codex threads (${snapshot.source}${snapshot.stale ? ", stale" : ""}):`,
      ...snapshot.threads
        .slice(0, 10)
        .map((thread) => `- ${formatThreadLine(thread)}\n  Watch: /codex watch ${thread.id}`),
    ].join("\n");
  }

  async activeWatches(): Promise<CodexBridgeWatchRecord[]> {
    const now = Date.now();
    const entries = await this.deps.watchStore.entries();
    const watches: CodexBridgeWatchRecord[] = [];
    for (const entry of entries) {
      if (Date.parse(entry.value.expiresAt) <= now) {
        await this.deps.watchStore.delete(entry.value.watchId);
        continue;
      }
      watches.push(entry.value);
    }
    return watches;
  }

  async recordAudit(
    input: Omit<
      CodexBridgeAuditEvent,
      "version" | "eventId" | "createdAt" | "retentionClass" | "privacyClass"
    > &
      Partial<Pick<CodexBridgeAuditEvent, "retentionClass" | "privacyClass">>,
  ): Promise<void> {
    const event = dropUndefined({
      version: 1,
      eventId: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      retentionClass: input.retentionClass ?? "medium",
      privacyClass: input.privacyClass ?? "normal",
      ...input,
      summary: redactCodexBridgeText(input.summary, 1000),
    }) as CodexBridgeAuditEvent;
    await this.deps.eventStore.register(event.eventId, event, { ttlMs: EVENT_STORE_TTL_MS });
  }

  private async sendWatchNotification(
    watch: CodexBridgeWatchRecord,
    text: string,
  ): Promise<boolean> {
    const target = watch.notifyTarget ?? this.config().notifyTarget;
    if (!target) {
      this.lastTelegramFailure = "no notify target configured";
      return false;
    }
    if (this.config().telegramDryRun) {
      this.lastTelegramFailure = undefined;
      this.deps.logger?.info?.("Codex continuity Telegram dry-run", { target, text });
      return true;
    }
    if (!this.deps.sendTelegram) {
      this.lastTelegramFailure = "telegram sender unavailable";
      return false;
    }
    try {
      await this.deps.sendTelegram({
        channel: watch.notifyChannel,
        target,
        text,
        accountId: watch.notifyAccountId,
        threadId: watch.notifyThreadId,
      });
      this.lastTelegramFailure = undefined;
      return true;
    } catch (error) {
      this.lastTelegramFailure = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
}

export function setCodexContinuityBridgeForRuntime(
  bridge: CodexContinuityBridge | undefined,
): void {
  const state = globalThis as typeof globalThis & {
    [CODEX_CONTINUITY_GLOBAL]?: CodexContinuityBridge;
  };
  state[CODEX_CONTINUITY_GLOBAL] = bridge;
}

export function getCodexContinuityBridge(): CodexContinuityBridge | undefined {
  return (globalThis as typeof globalThis & { [CODEX_CONTINUITY_GLOBAL]?: CodexContinuityBridge })[
    CODEX_CONTINUITY_GLOBAL
  ];
}

export function resetCodexContinuityBridgeForTests(): void {
  setCodexContinuityBridgeForRuntime(undefined);
}

function activeThreads(
  threads: CodexBridgeSnapshot["threads"],
): CodexBridgeSnapshot["activeThreads"] {
  return threads.filter((thread) => thread.status === "active");
}

function sortThreads<T extends { updatedAtMs?: number; createdAtMs?: number }>(threads: T[]): T[] {
  return threads.toSorted(
    (left, right) =>
      (right.updatedAtMs ?? right.createdAtMs ?? 0) - (left.updatedAtMs ?? left.createdAtMs ?? 0),
  );
}

function eventForWatch(
  snapshot: CodexBridgeSnapshot,
  watch: CodexBridgeWatchRecord,
): CodexBridgeEventInput | undefined {
  const thread = watch.threadId
    ? snapshot.threads.find((candidate) => candidate.id === watch.threadId)
    : watch.goalKey
      ? snapshot.threads.find((candidate) => candidate.goal?.goalKey === watch.goalKey)
      : watch.repoPath
        ? snapshot.threads.find((candidate) => candidate.cwd === watch.repoPath)
        : snapshot.latestThread;
  if (!thread) {
    return undefined;
  }
  const status = thread.goal?.status ?? thread.status;
  if (!["complete", "failed", "paused", "budget_limited"].includes(status ?? "")) {
    return undefined;
  }
  return {
    eventType: "watch_poll",
    threadId: thread.id,
    goalKey: thread.goal?.goalKey,
    status,
    source: snapshot.source,
    updatedAtMs: thread.goal?.updatedAtMs ?? thread.updatedAtMs,
    summary:
      status === "complete"
        ? `Codex finished ${thread.goal?.objective ?? thread.title ?? thread.id}`
        : `Codex status is ${status ?? thread.status} for ${thread.goal?.objective ?? thread.title ?? thread.id}`,
  };
}

function formatWatchNotification(params: {
  watch: CodexBridgeWatchRecord;
  event: CodexBridgeEventInput;
  eventClass: string;
  delayed: boolean;
}): string {
  const prefix = params.delayed ? "Delayed update: " : "";
  if (params.watch.sensitivity === "no_telegram_details") {
    return `${prefix}Codex ${params.eventClass} on watched ${params.watch.scope}.`;
  }
  return redactCodexBridgeText(
    `${prefix}${params.event.summary ?? `Codex ${params.eventClass}`}`,
    900,
  );
}

function formatThreadLine(thread: CodexBridgeSnapshot["threads"][number]): string {
  const parts = [
    formatCodexDisplayText(thread.id),
    thread.status,
    thread.cwd ? formatCodexDisplayText(thread.cwd) : undefined,
    thread.goal?.objective
      ? formatCodexDisplayText(thread.goal.objective)
      : thread.title
        ? formatCodexDisplayText(thread.title)
        : undefined,
    thread.updatedAtMs ? new Date(thread.updatedAtMs).toISOString() : undefined,
  ].filter(Boolean);
  return parts.join(" | ");
}

function dropUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
