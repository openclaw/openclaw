/**
 * Live local session source for the user's Codex daemon: publishes the threads
 * the local TUI is running (or could resume) to the OpenClaw team bridge and
 * relays team input as turn/start or queued follow-ups.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  formatLocalSessionInputEnvelope,
  LOCAL_SESSION_BOOTSTRAP_MAX_BYTES,
  LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS,
  type LocalSessionGatewayInputFrame,
  type LocalSessionRecord,
  type LocalSessionSourceDefinition,
  type LocalSessionSourceHost,
  type LocalSessionSourceSession,
  type LocalSessionSourceStartOptions,
  type LocalSessionThreadState,
} from "openclaw/plugin-sdk/local-session-source";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexAppServerUserHomeDir } from "./app-server/auth-start-options.js";
import type {
  CodexThread,
  CodexThreadItem,
  CodexThreadStatus,
  CodexTurn,
} from "./app-server/protocol.js";
import {
  type CodexObserverClient,
  type CodexObserverNotification,
  CodexObserverUncertainError,
  connectCodexObserverClient,
  ensureCodexDaemonRunning,
  resolveCodexDaemonSocketPath,
} from "./local-session-observer-client.js";
import { projectCodexThreadHistory, projectCodexThreadItem } from "./local-session-records.js";

const CODEX_LOCAL_SESSION_SOURCE_COMMAND = "codex.localSessions.source.v1";

/** Recent stored threads offered as resumable; older ones stay reachable by the user's own `codex resume`. */
const LOADED_THREAD_PAGE_LIMIT = 100;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const DAEMON_DISCONNECTED_REASON = "codex daemon disconnected";

type TrackedThread = {
  threadId: string;
  /** Per-thread FIFO: bootstrap, live records, and session frames never interleave. */
  chain: Promise<void>;
  /** Highest seq the Gateway has been sent; also the resume cursor after a reconnect. */
  lastSeq: number;
  recordIds: Set<string>;
  loaded: boolean;
  state: LocalSessionThreadState;
  /** History could not be read yet; retry the bootstrap on the next status change. */
  bootstrapRetry?: boolean;
  title?: string;
  cwd?: string;
  startedAt?: number;
  updatedAt?: number;
};

function threadStateOf(status: CodexThreadStatus | null | undefined): LocalSessionThreadState {
  switch (status?.type) {
    case "active":
      return "active";
    case "systemError":
      return "unavailable";
    default:
      return "idle";
  }
}

function secondsToMs(seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

function threadTitle(thread: CodexThread): string | undefined {
  const title = (thread.name ?? thread.preview ?? "").trim();
  return title ? title.slice(0, 512) : undefined;
}

function turnFrameState(turn: CodexTurn): "completed" | "failed" | "interrupted" {
  return turn.status === "failed" || turn.status === "interrupted" ? turn.status : "completed";
}

function trimBootstrap(records: LocalSessionRecord[]): LocalSessionRecord[] {
  let bytes = 0;
  let start = records.length;
  while (start > 0 && records.length - start < LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS) {
    const next = records[start - 1];
    bytes += Buffer.byteLength(next?.text ?? "", "utf8");
    if (bytes > LOCAL_SESSION_BOOTSTRAP_MAX_BYTES) {
      break;
    }
    start -= 1;
  }
  return records.slice(start);
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CodexLocalSessionSession implements LocalSessionSourceSession {
  private readonly threads = new Map<string, TrackedThread>();
  private readonly excluded: Set<string>;
  private readonly env = process.env;
  private readonly socketPath = resolveCodexDaemonSocketPath(process.env);
  private client: CodexObserverClient | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly host: LocalSessionSourceHost,
    private readonly options: LocalSessionSourceStartOptions,
  ) {
    this.excluded = new Set(options.excludedThreadIds);
  }

  /** Fails loudly when the daemon cannot be reached at all; later drops reconnect quietly. */
  async start(): Promise<void> {
    await this.connectAndInventory();
    this.loop = this.runReconnectLoop();
  }

  async submitInput(input: LocalSessionGatewayInputFrame): Promise<void> {
    const tracked = this.threads.get(input.threadId);
    const reject = (reason: string) =>
      this.host.reportInput({
        inputId: input.inputId,
        threadId: input.threadId,
        outcome: "rejected",
        reason,
      });
    if (!tracked || this.excluded.has(input.threadId)) {
      await reject("thread is not shared from this device");
      return;
    }
    if (tracked.state === "closed") {
      await reject("thread is closed");
      return;
    }
    const client = this.client;
    if (!client) {
      await reject(DAEMON_DISCONNECTED_REASON);
      return;
    }
    const text = formatLocalSessionInputEnvelope({
      senderDisplayName: input.sender.displayName,
      inputId: input.inputId,
      text: input.text,
    });
    const params = {
      threadId: input.threadId,
      input: [{ type: "text", text }],
      clientUserMessageId: input.inputId,
    };
    if (!tracked.loaded) {
      // Sharing covers what the daemon has loaded; the team must not wake a
      // dormant thread (and its tools) without the owner attaching it locally.
      await reject("the device unloaded this thread; its owner has to resume it locally first");
      return;
    }
    try {
      // A queued follow-up only starts when a running turn ends; on an idle
      // thread it would sit in the queue, so idle threads start a turn instead.
      if (input.mode === "followup" && tracked.state === "active") {
        const result = await client.request("thread/queue/add", params);
        const queued =
          isRecord(result) && isRecord(result.queuedSubmission)
            ? result.queuedSubmission
            : undefined;
        await this.host.reportInput({
          inputId: input.inputId,
          threadId: input.threadId,
          outcome: "submitted",
          ...(typeof queued?.id === "string" ? { nativeRef: queued.id } : {}),
        });
        return;
      }
      // turn/start starts a turn or steers the active one (codex-rs turn_processor start_or_steer_turn).
      const result = await client.request("turn/start", params);
      const turn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
      await this.host.reportInput({
        inputId: input.inputId,
        threadId: input.threadId,
        outcome: "committed",
        ...(typeof turn?.id === "string" ? { nativeRef: turn.id } : {}),
      });
    } catch (error) {
      if (error instanceof CodexObserverUncertainError) {
        // The daemon may already have applied the turn; a rejection would
        // invite a retry that runs the instruction twice. Stay submitted until
        // the mirrored user message (clientId) settles it or the owner checks.
        await this.host.reportInput({
          inputId: input.inputId,
          threadId: input.threadId,
          outcome: "submitted",
          reason: `${error.message}; check the local session before sending again`,
        });
        return;
      }
      await reject(errorMessage(error));
    }
  }

  unshare(threadId: string): void {
    this.excluded.add(threadId);
    const tracked = this.threads.get(threadId);
    if (!tracked || tracked.state === "closed") {
      return;
    }
    this.enqueue(tracked, () => this.publishSession(tracked, "closed", { reason: "unshared" }));
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = undefined;
    await this.loop;
  }

  private get signal(): AbortSignal {
    return this.options.signal;
  }

  private enqueue(tracked: TrackedThread, work: () => Promise<void>): void {
    tracked.chain = tracked.chain.then(work).catch((error: unknown) => {
      embeddedAgentLog.debug("codex local session thread work failed", {
        threadId: tracked.threadId,
        error,
      });
    });
  }

  private async connect(): Promise<CodexObserverClient> {
    try {
      return await connectCodexObserverClient({ socketPath: this.socketPath, env: this.env });
    } catch (error) {
      if (!existsSync(this.socketPath)) {
        embeddedAgentLog.debug("codex daemon socket missing; starting daemon", { error });
      }
      const codex = resolveNodeHostExecutable("codex", { env: this.env, strategy: "direct" });
      if (!codex) {
        throw new Error("codex executable is not on PATH; install Codex on this device", {
          cause: error,
        });
      }
      await ensureCodexDaemonRunning(codex.executable, this.env, this.signal);
      return await connectCodexObserverClient({ socketPath: this.socketPath, env: this.env });
    }
  }

  private async connectAndInventory(): Promise<void> {
    const client = await this.connect();
    client.onNotification((notification) => this.handleNotification(notification));
    this.client = client;
    await this.runInventory(client);
  }

  private async runReconnectLoop(): Promise<void> {
    let backoffMs = RECONNECT_MIN_MS;
    while (!this.signal.aborted && this.client) {
      const reason = await this.client.closed;
      this.client = undefined;
      if (this.signal.aborted) {
        return;
      }
      embeddedAgentLog.debug("codex daemon connection dropped", { reason });
      for (const tracked of this.threads.values()) {
        if (tracked.state !== "closed") {
          this.enqueue(tracked, () =>
            this.publishSession(tracked, "unavailable", { reason: DAEMON_DISCONNECTED_REASON }),
          );
        }
      }
      while (!this.signal.aborted) {
        await sleepUnlessAborted(backoffMs, this.signal);
        if (this.signal.aborted) {
          return;
        }
        try {
          await this.connectAndInventory();
          backoffMs = RECONNECT_MIN_MS;
          break;
        } catch (error) {
          embeddedAgentLog.debug("codex daemon reconnect failed", { error, backoffMs });
          backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        }
      }
    }
  }

  private async listLoadedThreadIds(client: CodexObserverClient): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.request("thread/loaded/list", {
        limit: LOADED_THREAD_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(result) || !Array.isArray(result.data)) {
        break;
      }
      ids.push(...result.data.filter((id): id is string => typeof id === "string"));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor && ids.length < LOADED_THREAD_PAGE_LIMIT * 5);
    return ids;
  }

  /**
   * Only threads the daemon has loaded are shared: they are joined as a listener
   * via thread/resume (no overrides => rejoin, codex-rs thread_processor.rs
   * resume_running_thread). Stored-but-unloaded threads stay private; consent
   * covers live work, not the whole history on disk.
   */
  private async runInventory(client: CodexObserverClient): Promise<void> {
    for (const threadId of await this.listLoadedThreadIds(client)) {
      this.attachThread(threadId, { loaded: true });
    }
  }

  /** Idempotent: registers the thread synchronously, then bootstraps on its chain. */
  private attachThread(threadId: string, options: { loaded: boolean }): void {
    if (this.excluded.has(threadId)) {
      return;
    }
    let tracked = this.threads.get(threadId);
    if (!tracked) {
      tracked = {
        threadId,
        chain: Promise.resolve(),
        lastSeq: this.options.cursors[threadId] ?? 0,
        recordIds: new Set(),
        loaded: options.loaded,
        state: "idle",
      };
      this.threads.set(threadId, tracked);
    }
    const current = tracked;
    current.loaded = options.loaded;
    if (current.state === "closed") {
      // Unloaded earlier; the owner resumed it locally, so it is live again.
      current.state = "idle";
    }
    this.enqueue(current, () => this.bootstrapThread(current));
  }

  private async bootstrapThread(tracked: TrackedThread): Promise<void> {
    const client = this.client;
    if (!client || tracked.state === "closed") {
      return;
    }
    let result: unknown;
    try {
      result = await client.request("thread/resume", { threadId: tracked.threadId });
    } catch (error) {
      // A thread the TUI just created has no rollout until its first user turn, and
      // legacy stores cannot page history. Publish the row anyway so the team sees
      // it; live events still arrive for threads created after this connection, and
      // the next status change retries the bootstrap.
      const summary = await client
        .request("thread/read", { threadId: tracked.threadId, includeTurns: false })
        .catch(() => undefined);
      const thread =
        // SAFETY: thread/read returned an object under `thread`; the app-server protocol owns its shape.
        isRecord(summary) && isRecord(summary.thread) ? (summary.thread as CodexThread) : undefined;
      tracked.title = thread ? threadTitle(thread) : tracked.title;
      tracked.cwd = thread?.cwd ?? tracked.cwd;
      tracked.bootstrapRetry = true;
      embeddedAgentLog.debug("codex local session bootstrap deferred", {
        threadId: tracked.threadId,
        error,
      });
      await this.publishSession(tracked, threadStateOf(thread?.status), {
        reason: "history is not readable yet; live turns only",
      });
      return;
    }
    tracked.bootstrapRetry = false;
    if (!isRecord(result) || !isRecord(result.thread)) {
      throw new Error(`codex returned no thread for ${tracked.threadId}`);
    }
    // SAFETY: guarded by isRecord(result.thread) above; shape is the app-server thread contract.
    const thread = result.thread as CodexThread;
    tracked.title = threadTitle(thread);
    tracked.cwd = thread.cwd ?? undefined;
    tracked.startedAt = secondsToMs(thread.createdAt);
    tracked.updatedAt = secondsToMs(thread.updatedAt);

    // seq is the 1-based position in the projected history; the projection is
    // pure, so a reconnect renumbers identically and cursors stay valid.
    const history = projectCodexThreadHistory(thread, Date.now()).map((record, index) =>
      Object.assign(record, { seq: index + 1 }),
    );
    const isFirstAttach = tracked.recordIds.size === 0 && tracked.lastSeq === 0;
    for (const record of history) {
      tracked.recordIds.add(record.id);
    }
    let pending = history.filter((record) => record.seq > tracked.lastSeq);
    if (isFirstAttach) {
      pending = trimBootstrap(pending);
    }
    // A reverted thread can shrink below an older cursor; keep seq monotone
    // from the cursor rather than re-emitting numbers the Gateway already saw.
    tracked.lastSeq = Math.max(tracked.lastSeq, history.length);
    // Only a trimmed bootstrap leaves history behind on the laptop; a full page
    // starts at seq 1 and needs no marker.
    const earliestSeq =
      isFirstAttach && pending[0] !== undefined && pending[0].seq > 1 ? pending[0].seq : undefined;
    await this.publishSession(
      tracked,
      threadStateOf(thread.status),
      earliestSeq !== undefined ? { earliestSeq } : {},
    );
    if (pending.length > 0) {
      await this.host.publishRecords(tracked.threadId, pending);
      tracked.lastSeq = Math.max(tracked.lastSeq, pending[pending.length - 1]?.seq ?? 0);
    }
  }

  private async publishSession(
    tracked: TrackedThread,
    state: LocalSessionThreadState,
    extra: { reason?: string; earliestSeq?: number } = {},
  ): Promise<void> {
    tracked.state = state;
    await this.host.publishSession({
      threadId: tracked.threadId,
      state,
      canInput: state === "idle" || state === "active",
      ...(tracked.title ? { title: tracked.title } : {}),
      ...(tracked.cwd ? { cwd: tracked.cwd } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(tracked.startedAt !== undefined ? { startedAt: tracked.startedAt } : {}),
      ...(tracked.updatedAt !== undefined ? { updatedAt: tracked.updatedAt } : {}),
      ...(extra.earliestSeq !== undefined ? { earliestSeq: extra.earliestSeq } : {}),
    });
  }

  private async appendLiveItem(
    tracked: TrackedThread,
    turnId: string,
    item: CodexThreadItem,
    ts: number,
  ): Promise<void> {
    const records: LocalSessionRecord[] = [];
    for (const projected of projectCodexThreadItem(item)) {
      if (tracked.recordIds.has(projected.id)) {
        continue;
      }
      tracked.recordIds.add(projected.id);
      tracked.lastSeq += 1;
      records.push({ ...projected, seq: tracked.lastSeq, ts, turnId });
    }
    tracked.updatedAt = ts;
    if (records.length > 0) {
      await this.host.publishRecords(tracked.threadId, records);
    }
  }

  private trackedFor(params: unknown): TrackedThread | undefined {
    if (!isRecord(params) || typeof params.threadId !== "string") {
      return undefined;
    }
    const tracked = this.threads.get(params.threadId);
    return tracked && tracked.state !== "closed" && !this.excluded.has(params.threadId)
      ? tracked
      : undefined;
  }

  private handleNotification(notification: CodexObserverNotification): void {
    const { method, params } = notification;
    if (method === "thread/started") {
      const thread = isRecord(params) && isRecord(params.thread) ? params.thread : undefined;
      if (typeof thread?.id === "string") {
        this.attachThread(thread.id, { loaded: true });
      }
      return;
    }
    if (method === "thread/status/changed" && isRecord(params)) {
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      // Broadcast to every connection (codex-rs thread_status.rs), so a thread
      // the user resumed outside our inventory window, or after it was
      // unloaded, surfaces here.
      const known = threadId ? this.threads.get(threadId) : undefined;
      // SAFETY: thread/status/changed carries the app-server ThreadStatus union.
      const nextStatus = params.status as CodexThreadStatus | undefined;
      if (threadId && (!known || known.state === "closed") && nextStatus?.type !== "notLoaded") {
        this.attachThread(threadId, { loaded: true });
        return;
      }
    }
    const tracked = this.trackedFor(params);
    if (!tracked || !isRecord(params)) {
      return;
    }
    switch (method) {
      case "thread/status/changed": {
        // SAFETY: thread/status/changed carries the app-server ThreadStatus union.
        const status = params.status as CodexThreadStatus | undefined;
        if (status?.type === "notLoaded") {
          tracked.loaded = false;
          this.enqueue(tracked, () =>
            this.publishSession(tracked, "closed", { reason: "unloaded on the device" }),
          );
          return;
        }
        if (tracked.bootstrapRetry) {
          // The thread now has activity, so its rollout and history exist; a
          // successful bootstrap also (re)attaches this connection as a listener.
          this.enqueue(tracked, () => this.bootstrapThread(tracked));
          return;
        }
        this.enqueue(tracked, () => this.publishSession(tracked, threadStateOf(status)));
        return;
      }
      case "thread/closed":
        // Idle unload after 30 minutes: the row closes until the owner resumes
        // the thread locally, which surfaces it again as a loaded thread.
        tracked.loaded = false;
        this.enqueue(tracked, () =>
          this.publishSession(tracked, "closed", { reason: "unloaded on the device" }),
        );
        return;
      case "thread/archived":
      case "thread/deleted":
        this.enqueue(tracked, () =>
          this.publishSession(tracked, "closed", { reason: `thread ${method.slice(7)}` }),
        );
        return;
      case "turn/started":
      case "turn/completed": {
        // SAFETY: guarded by isRecord(params.turn); app-server Turn contract.
        const turn = isRecord(params.turn) ? (params.turn as CodexTurn) : undefined;
        if (!turn || typeof turn.id !== "string") {
          return;
        }
        const state = method === "turn/started" ? "started" : turnFrameState(turn);
        this.enqueue(tracked, () =>
          this.host.publishTurn({ threadId: tracked.threadId, turnId: turn.id, state }),
        );
        return;
      }
      case "item/completed": {
        // SAFETY: guarded by isRecord(params.item); app-server ThreadItem contract.
        const item = isRecord(params.item) ? (params.item as CodexThreadItem) : undefined;
        const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
        if (!item || typeof item.id !== "string" || !turnId) {
          return;
        }
        const ts = typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now();
        this.enqueue(tracked, () => this.appendLiveItem(tracked, turnId, item, ts));
        return;
      }
      case "item/agentMessage/delta": {
        const { turnId, itemId, delta } = params;
        if (typeof turnId !== "string" || typeof itemId !== "string" || typeof delta !== "string") {
          return;
        }
        this.enqueue(tracked, () =>
          this.host.publishDelta({ threadId: tracked.threadId, turnId, itemId, text: delta }),
        );
      }
    }
  }
}

function isCodexLocalSessionSourceAvailable(env: NodeJS.ProcessEnv): boolean {
  // The daemon control socket is a Unix socket (codex-rs tui only probes it on unix).
  return (
    process.platform !== "win32" &&
    Boolean(resolveNodeHostExecutable("codex", { env, strategy: "direct" })) &&
    existsSync(resolveCodexAppServerUserHomeDir(env))
  );
}

export function createCodexLocalSessionSource(): LocalSessionSourceDefinition {
  return {
    id: "codex",
    label: "Codex",
    command: CODEX_LOCAL_SESSION_SOURCE_COMMAND,
    hostLabel: os.hostname(),
    inputModes: ["steer", "followup"],
    isAvailable: ({ env }) => isCodexLocalSessionSourceAvailable(env),
    start: async (host, options) => {
      const session = new CodexLocalSessionSession(host, options);
      await session.start();
      return session;
    },
  };
}
