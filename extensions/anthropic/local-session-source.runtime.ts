// Runtime of the Claude Code live local session source (lazy boundary; the
// definition in local-session-source.ts loads this on first start). Records
// come from tailing the JSONL transcripts; team input reaches the running
// session through the Claude channel bridge (see local-session-bridge.ts).
import path from "node:path";
import {
  formatLocalSessionInputEnvelope,
  type LocalSessionGatewayInputFrame,
  type LocalSessionRecord,
  type LocalSessionSourceHost,
  type LocalSessionSourceSession,
  type LocalSessionSourceStartOptions,
} from "openclaw/plugin-sdk/local-session-source";
import {
  createClaudeChannelBridge,
  resolveClaudeChannelBridgeEndpoint,
} from "./local-session-bridge.js";
import {
  createClaudeTranscriptTailer,
  toWireRecord,
  type ClaudeTranscriptRecord,
  type ClaudeTranscriptTailer,
} from "./local-session-transcript-tail.js";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";
import { gatewayClaudeScanOptions, projectsDir } from "./session-catalog-scan.js";
import { createDirtyDirectoryWatch } from "./session-catalog-tree-watch.js";

/** Same bound as the Beam mirror: the newest sessions by activity. */
const MAX_TRACKED_SESSIONS = 32;
const ACTIVE_WINDOW_MS = 120_000;
const WATCH_TICK_MS = 250;
const POLL_BACKSTOP_MS = 5_000;
const NO_CHANNEL_REASON = "start Claude Code with the openclaw channel to accept team messages";

export type ClaudeLocalSessionSourceRuntimeOptions = {
  homeDir?: string;
  scanOptions?: { configDir?: string; includeDesktop?: boolean };
  bridgeEndpoint?: string;
  tickMs?: number;
  backstopMs?: number;
  activeWindowMs?: number;
};

type CatalogEntry = Awaited<ReturnType<typeof listClaudeSessions>>[number];

type TrackedThread = {
  threadId: string;
  filePath: string;
  tailer: ClaudeTranscriptTailer;
  title?: string;
  cwd?: string;
  startedAt?: number;
  updatedAt?: number;
  state: "idle" | "active";
  canInput: boolean;
  earliestSeq?: number;
  /** User record id of the turn Claude is answering; cleared on the ending assistant record or Stop hook. */
  activeTurnId?: string;
};

function catalogTitle(entry: CatalogEntry): string | undefined {
  return entry.name?.trim() ? entry.name.trim().slice(0, 512) : undefined;
}

function sessionFrame(thread: TrackedThread) {
  return {
    threadId: thread.threadId,
    state: thread.state,
    canInput: thread.canInput,
    ...(thread.title ? { title: thread.title } : {}),
    ...(thread.cwd ? { cwd: thread.cwd.slice(0, 4096) } : {}),
    ...(thread.canInput ? {} : { reason: NO_CHANNEL_REASON }),
    ...(thread.startedAt !== undefined ? { startedAt: thread.startedAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.earliestSeq !== undefined ? { earliestSeq: thread.earliestSeq } : {}),
  };
}

export async function startClaudeLocalSessionSource(
  host: LocalSessionSourceHost,
  options: LocalSessionSourceStartOptions,
  config: ClaudeLocalSessionSourceRuntimeOptions,
): Promise<LocalSessionSourceSession> {
  const homeDir = config.homeDir ?? resolveClaudeCatalogHomeDir();
  const scanOptions = config.scanOptions ?? gatewayClaudeScanOptions(true);
  const activeWindowMs = config.activeWindowMs ?? ACTIVE_WINDOW_MS;
  const tracked = new Map<string, TrackedThread>();
  const excluded = new Set(options.excludedThreadIds);
  let stopped = false;

  const publish = async (work: () => Promise<void>) => {
    if (stopped || options.signal.aborted) {
      return;
    }
    try {
      await work();
    } catch {
      // The duplex is gone; the command runtime tears the session down.
    }
  };

  const publishSession = (thread: TrackedThread) =>
    publish(() => host.publishSession(sessionFrame(thread)));

  const emitRecords = async (thread: TrackedThread, records: ClaudeTranscriptRecord[]) => {
    if (records.length === 0) {
      return;
    }
    // Records and turn frames share one ordered duplex, so flush pending records
    // before every turn boundary; the Gateway relies on seq order per thread.
    const pending: LocalSessionRecord[] = [];
    const flush = async () => {
      if (pending.length > 0) {
        const batch = pending.splice(0);
        await publish(() => host.publishRecords(thread.threadId, batch));
      }
    };
    const publishTurn = (turnId: string, state: "started" | "completed") =>
      publish(() => host.publishTurn({ threadId: thread.threadId, turnId, state }));
    for (const record of records) {
      // A user record opens a turn until the assistant record Claude marked as the
      // turn end (or the Stop hook) closes it.
      if (record.kind === "user") {
        await flush();
        thread.activeTurnId = record.id;
        await publishTurn(record.id, "started");
      }
      const turnId = thread.activeTurnId;
      pending.push({ ...toWireRecord(record), ...(turnId ? { turnId } : {}) });
      if (record.endsTurn && turnId) {
        await flush();
        thread.activeTurnId = undefined;
        await publishTurn(turnId, "completed");
      }
    }
    await flush();
  };

  const closeThread = async (threadId: string, reason: string) => {
    const thread = tracked.get(threadId);
    if (!thread) {
      return;
    }
    tracked.delete(threadId);
    await publish(() =>
      host.publishSession({
        threadId,
        state: "closed",
        canInput: false,
        reason,
        ...(thread.title ? { title: thread.title } : {}),
      }),
    );
  };

  // Consent covers running sessions. A transcript on disk is admitted only once
  // a hook or channel proves its Claude process is live; dormant history stays
  // on the laptop.
  const live = new Set<string>();
  const markLive = (sessionId: string) => {
    if (!live.has(sessionId)) {
      live.add(sessionId);
      void enumerate().catch(() => {});
    }
  };

  const onPairingChange = (sessionId: string, connected: boolean) => {
    if (connected) {
      markLive(sessionId);
    }
    const thread = tracked.get(sessionId);
    if (thread && thread.canInput !== connected) {
      thread.canInput = connected;
      void publishSession(thread);
    }
  };

  const onHook = (event: { name: string; sessionId: string }) => {
    if (event.name === "SessionEnd") {
      // The row closes and leaves the tracking quota; a later SessionStart
      // (resume) admits it again from its cursor.
      live.delete(event.sessionId);
      void closeThread(event.sessionId, "session ended");
      return;
    }
    markLive(event.sessionId);
    const thread = tracked.get(event.sessionId);
    if (!thread) {
      return;
    }
    if (event.name === "Stop" && thread.activeTurnId) {
      const turnId = thread.activeTurnId;
      thread.activeTurnId = undefined;
      void publish(() =>
        host.publishTurn({ threadId: thread.threadId, turnId, state: "completed" }),
      );
    }
  };

  const bridge = await createClaudeChannelBridge({
    endpoint: config.bridgeEndpoint ?? resolveClaudeChannelBridgeEndpoint(),
    events: { onPairingChange, onHook },
  });

  const admit = async (entry: CatalogEntry, cursor: number) => {
    const tailer = createClaudeTranscriptTailer(entry.filePath);
    const bootstrap = await tailer.bootstrap(cursor);
    if (bootstrap.oversized) {
      await publish(() =>
        host.publishSession({
          threadId: entry.threadId,
          state: "unavailable",
          canInput: false,
          reason: "transcript exceeds the live projection size limit",
        }),
      );
      return;
    }
    const updatedAt = entry.recencyAt ?? entry.updatedAt;
    const thread: TrackedThread = {
      threadId: entry.threadId,
      filePath: entry.filePath,
      tailer,
      title: catalogTitle(entry),
      cwd: entry.cwd,
      startedAt: entry.createdAt,
      updatedAt,
      state: updatedAt !== undefined && Date.now() - updatedAt < activeWindowMs ? "active" : "idle",
      canInput: bridge.isConnected(entry.threadId),
      earliestSeq: bootstrap.earliestSeq,
    };
    tracked.set(entry.threadId, thread);
    await publishSession(thread);
    // Bootstrap replays history; the turn frames it would imply already ended.
    const history = bootstrap.records.map((record) => toWireRecord(record));
    if (history.length > 0) {
      await publish(() => host.publishRecords(thread.threadId, history));
    }
  };

  const tailThread = async (thread: TrackedThread) => {
    const { records, missing } = await thread.tailer.readNext();
    if (missing) {
      await closeThread(thread.threadId, "transcript removed");
      return;
    }
    if (records.length > 0) {
      thread.updatedAt = records.at(-1)?.ts ?? Date.now();
    }
    await emitRecords(thread, records);
    const state =
      thread.updatedAt !== undefined && Date.now() - thread.updatedAt < activeWindowMs
        ? "active"
        : "idle";
    if (state !== thread.state) {
      thread.state = state;
      await publishSession(thread);
    }
  };

  const enumerate = async () => {
    const entries = await listClaudeSessions(homeDir, scanOptions);
    let admitted = tracked.size;
    for (const entry of entries) {
      if (excluded.has(entry.threadId) || !live.has(entry.threadId)) {
        continue;
      }
      const existing = tracked.get(entry.threadId);
      if (existing) {
        const title = catalogTitle(entry);
        if (title && title !== existing.title) {
          existing.title = title;
          await publishSession(existing);
        }
        continue;
      }
      if (admitted >= MAX_TRACKED_SESSIONS) {
        continue;
      }
      admitted += 1;
      await admit(entry, options.cursors[entry.threadId] ?? 0);
    }
  };

  await enumerate();

  const projectsRoot = projectsDir(homeDir, scanOptions.configDir);
  const watch = createDirtyDirectoryWatch(projectsRoot);
  let lastBackstopAt = Date.now();
  let ticking = false;
  const tick = async () => {
    if (ticking || stopped) {
      return;
    }
    ticking = true;
    try {
      const dirty = watch.takeDirty();
      const backstopDue = Date.now() - lastBackstopAt >= (config.backstopMs ?? POLL_BACKSTOP_MS);
      const changed = dirty === "all" || dirty.size > 0;
      if (!changed && !backstopDue) {
        return;
      }
      if (backstopDue) {
        lastBackstopAt = Date.now();
      }
      // Catalog file paths are realpath-resolved while the watch root is logical, so
      // match dirty project directories by name rather than by full path.
      for (const thread of tracked.values()) {
        const projectName = path.basename(path.dirname(thread.filePath));
        if (dirty === "all" || backstopDue || dirty.has(projectName)) {
          await tailThread(thread);
        }
      }
      await enumerate();
    } catch {
      // A failed tick retries on the next interval; the backstop guarantees progress.
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), config.tickMs ?? WATCH_TICK_MS);

  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    watch.close();
    await bridge.close();
  };
  options.signal.addEventListener("abort", () => void stop(), { once: true });

  return {
    submitInput: async (input: LocalSessionGatewayInputFrame) => {
      const report = (result: { outcome: "submitted" | "rejected"; reason?: string }) =>
        publish(() =>
          host.reportInput({
            inputId: input.inputId,
            threadId: input.threadId,
            outcome: result.outcome,
            ...(result.outcome === "submitted" ? { nativeRef: input.inputId } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          }),
        );
      const thread = tracked.get(input.threadId);
      if (!thread) {
        await report({ outcome: "rejected", reason: "session is not shared from this device" });
        return;
      }
      if (input.mode !== "followup") {
        await report({
          outcome: "rejected",
          reason: "Claude Code channels deliver on the next turn only",
        });
        return;
      }
      if (!bridge.isConnected(input.threadId)) {
        await report({ outcome: "rejected", reason: NO_CHANNEL_REASON });
        return;
      }
      const delivery = await bridge.sendInput({
        sessionId: input.threadId,
        inputId: input.inputId,
        content: formatLocalSessionInputEnvelope({
          senderDisplayName: input.sender.displayName,
          inputId: input.inputId,
          text: input.text,
        }),
        meta: { sender: input.sender.displayName, openclaw_input_id: input.inputId },
      });
      // Claude Code never acks channel events; a written notification is the strongest
      // proof available, and the echoed user record (clientId) later confirms delivery.
      await report(
        delivery.ok ? { outcome: "submitted" } : { outcome: "rejected", reason: delivery.reason },
      );
    },
    unshare: (threadId) => {
      excluded.add(threadId);
      void closeThread(threadId, "unshared");
    },
    stop,
  };
}
