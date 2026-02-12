import * as fs from "node:fs";
import * as path from "node:path";
import { matrixFetch, MatrixApiError, updateAccessToken } from "./http.js";
import { processStateEvents, cleanupRoom, isRoomEncrypted } from "./rooms.js";
import { getMachine, closeMachine } from "../crypto/machine.js";
import { processOutgoingRequests } from "../crypto/outgoing.js";
import type {
  MatrixSyncResponse,
  MatrixFilterResponse,
  MatrixEvent,
  MatrixLoginResponse,
  UTDQueueEntry,
} from "../types.js";
import { RoomId, DeviceLists, UserId } from "@matrix-org/matrix-sdk-crypto-nodejs";

// ── Constants ──────────────────────────────────────────────────────────
const SYNC_TIMEOUT_MS = 30_000; // Server-side long-poll
const FETCH_TIMEOUT_MS = 40_000; // Client fetch = server + 10s buffer
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_CONSECUTIVE_FAILURES = 10;
const UTD_QUEUE_MAX = 200;
const UTD_MAX_AGE_MS = 5 * 60 * 1000; // 5 min
const UTD_EXPIRE_MS = 60 * 60 * 1000; // 1 hour — stop retrying
const MAX_EVENT_AGE_MS = 120_000; // Ignore messages older than 2 min (initial sync)

// ── UTD Queue ──────────────────────────────────────────────────────────
const utdQueue: UTDQueueEntry[] = [];

function pushUTD(entry: UTDQueueEntry): void {
  if (utdQueue.length >= UTD_QUEUE_MAX) {
    utdQueue.shift(); // Drop oldest
  }
  utdQueue.push(entry);
}

function removeUTDByEventId(eventId: string): void {
  const idx = utdQueue.findIndex((e) => e.event.event_id === eventId);
  if (idx >= 0) utdQueue.splice(idx, 1);
}

// ── Sync Token Persistence ─────────────────────────────────────────────
function getSyncTokenPath(storePath: string): string {
  return path.join(path.dirname(storePath), "sync-token.json");
}

function loadSyncToken(storePath: string): string | undefined {
  const tokenPath = getSyncTokenPath(storePath);
  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, "utf-8"));
    return data.next_batch;
  } catch {
    return undefined;
  }
}

function saveSyncToken(storePath: string, token: string): void {
  const tokenPath = getSyncTokenPath(storePath);
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify({ next_batch: token }), "utf-8");
}

// ── Sync Filter ────────────────────────────────────────────────────────
async function getOrCreateFilter(userId: string): Promise<string | null> {
  try {
    const response = await matrixFetch<MatrixFilterResponse>(
      "POST",
      `/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`,
      {
        room: {
          timeline: { limit: 1 },
          state: { lazy_load_members: true },
        },
      }
    );
    return response.filter_id;
  } catch {
    return null; // Fallback to inline filter
  }
}

// ── Types for the sync loop ────────────────────────────────────────────
export interface SyncLoopOpts {
  userId: string;
  cryptoStorePath: string;
  abortSignal: AbortSignal;
  onMessage: (event: MatrixEvent, roomId: string) => void | Promise<void>;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  setStatus?: (status: any) => void;
  password?: string;
  deviceName?: string;
}

/**
 * Main sync loop. Long-polls /sync, decrypts events, dispatches messages.
 *
 * Processing order (CRITICAL — order matters for decryption):
 * 1. Feed to-device events to OlmMachine FIRST (key deliveries)
 * 2. Retry UTD queue (new keys may have arrived)
 * 3. Process rooms.join (state → timeline → receipts)
 * 4. Process rooms.invite (log only, Phase 2: auto-join)
 * 5. Process rooms.leave (cleanup)
 * 6. Process outgoing requests (key uploads, to-device, key claims)
 */
export async function runSyncLoop(opts: SyncLoopOpts): Promise<void> {
  const { userId, cryptoStorePath, abortSignal, onMessage, log, setStatus } = opts;

  let nextBatch = loadSyncToken(cryptoStorePath);
  let consecutiveFailures = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  // Create or fetch a reusable filter
  const filterId = await getOrCreateFilter(userId);
  const inlineFilter = filterId
    ? null
    : JSON.stringify({
        room: { timeline: { limit: 1 }, state: { lazy_load_members: true } },
      });

  log?.info(`[sync] Starting sync loop (resuming: ${!!nextBatch})`);

  while (!abortSignal.aborted) {
    try {
      // Build sync URL
      let syncPath = "/_matrix/client/v3/sync?timeout=" + SYNC_TIMEOUT_MS;
      if (nextBatch) syncPath += `&since=${encodeURIComponent(nextBatch)}`;
      if (filterId) syncPath += `&filter=${encodeURIComponent(filterId)}`;
      else if (inlineFilter)
        syncPath += `&filter=${encodeURIComponent(inlineFilter)}`;

      const response = await matrixFetch<MatrixSyncResponse>(
        "GET",
        syncPath,
        undefined,
        { timeoutMs: FETCH_TIMEOUT_MS }
      );

      // Success — reset backoff
      consecutiveFailures = 0;
      backoffMs = INITIAL_BACKOFF_MS;

      // ── Step 1: Feed to-device events to OlmMachine FIRST ──
      const machine = getMachine();
      const toDeviceEvents = response.to_device?.events ?? [];
      const deviceLists = response.device_lists;
      const otkCounts = response.device_one_time_keys_count ?? {};
      const unusedFallbackKeys =
        response.device_unused_fallback_key_types ?? [];

      // DEBUG: Log to-device events and device list changes
      if (toDeviceEvents.length > 0) {
        log?.info?.(`[sync] Received ${toDeviceEvents.length} to-device event(s): ${toDeviceEvents.map((e: any) => e.type).join(", ")}`);
      }
      if (deviceLists?.changed?.length) {
        log?.info?.(`[sync] Device list changed for: ${deviceLists.changed.join(", ")}`);
      }
      if (Object.keys(otkCounts).length > 0) {
        log?.info?.(`[sync] OTK counts: ${JSON.stringify(otkCounts)}`);
      }

      // DeviceLists constructor: (changed?: Array<UserId> | undefined, left?: Array<UserId> | undefined)
      // Wrap in try/catch with string[] fallback in case FFI binding differs from .d.ts
      let deviceListsObj: DeviceLists;
      try {
        const changedUsers = (deviceLists?.changed ?? []).map((id: string) => new UserId(id));
        const leftUsers = (deviceLists?.left ?? []).map((id: string) => new UserId(id));
        deviceListsObj = new DeviceLists(changedUsers, leftUsers);
      } catch {
        // Fallback: some FFI versions accept plain strings
        log?.warn?.("[sync] DeviceLists(UserId[]) failed, falling back to string[]");
        deviceListsObj = new DeviceLists(
          (deviceLists?.changed ?? []) as any,
          (deviceLists?.left ?? []) as any
        );
      }

      // receiveSyncChanges signature:
      //   (toDeviceEvents: string, changedDevices: DeviceLists,
      //    oneTimeKeyCounts: Record<string, number>, unusedFallbackKeys: Array<string>)
      await machine.receiveSyncChanges(
        JSON.stringify(toDeviceEvents),
        deviceListsObj,
        otkCounts,
        unusedFallbackKeys
      );

      // ── Step 2: Retry UTD queue ──
      await retryUTDQueue(onMessage, log);

      // ── Step 3: Process rooms.join ──
      const joinedRooms = response.rooms?.join ?? {};
      for (const [roomId, room] of Object.entries(joinedRooms)) {
        // 3a. State events → update encryption cache
        if (room.state?.events) {
          processStateEvents(roomId, room.state.events);
        }

        // 3b. Timeline events
        if (room.timeline?.events) {
          // Process state events in timeline too
          const stateInTimeline = room.timeline.events.filter(
            (e) => e.state_key !== undefined
          );
          if (stateInTimeline.length) {
            processStateEvents(roomId, stateInTimeline);
          }

          // Process message events
          for (const event of room.timeline.events) {
            await processTimelineEvent(event, roomId, onMessage, log);
          }

          // 3c. Send read receipt for last event
          const lastEvent = room.timeline.events[room.timeline.events.length - 1];
          if (lastEvent?.event_id) {
            sendReadReceipt(roomId, lastEvent.event_id).catch(() => {});
          }
        }
      }

      // ── Step 4: Process rooms.invite (log only — Phase 2: auto-join) ──
      const invitedRooms = response.rooms?.invite ?? {};
      for (const roomId of Object.keys(invitedRooms)) {
        log?.info(`[sync] Invited to room ${roomId} (ignoring — Phase 2)`);
        // TODO Phase 2: auto-join for allowed users
      }

      // ── Step 5: Process rooms.leave ──
      const leftRooms = response.rooms?.leave ?? {};
      for (const roomId of Object.keys(leftRooms)) {
        cleanupRoom(roomId);
      }

      // ── Step 6: Process outgoing requests ──
      const preReqs = await getMachine().outgoingRequests();
      if (preReqs.length > 0) {
        log?.info?.(`[sync] Processing ${preReqs.length} outgoing request(s): ${preReqs.map((r: any) => r.type?.toString?.() ?? r.constructor?.name ?? "?").join(", ")}`);
      }
      await processOutgoingRequests(log);

      // Save sync token
      if (response.next_batch) {
        nextBatch = response.next_batch;
        saveSyncToken(cryptoStorePath, nextBatch);
      }

      // Update status
      setStatus?.({
        connected: true,
        lastEventAt: Date.now(),
        reconnectAttempts: 0,
      });
    } catch (err: any) {
      if (abortSignal.aborted) break;

      // Handle token invalidation (soft or hard logout)
      if (err instanceof MatrixApiError && err.errcode === "M_UNKNOWN_TOKEN") {
        try {
          await handleTokenError(err, opts, log);
          // Soft re-auth succeeded — resume sync
          continue;
        } catch {
          // Hard logout or re-auth failure — handleTokenError already logged details
          break;
        }
      }

      consecutiveFailures++;
      log?.error(
        `[sync] Sync failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`
      );

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log?.error("[sync] Too many consecutive failures, marking degraded");
        setStatus?.({
          connected: false,
          lastError: err.message,
          reconnectAttempts: consecutiveFailures,
        });
      }

      // Exponential backoff with jitter
      const jitter = Math.random() * backoffMs * 0.5;
      await sleep(backoffMs + jitter, abortSignal);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  log?.info("[sync] Sync loop stopped");
}

// ── Timeline Event Processing ──────────────────────────────────────────
async function processTimelineEvent(
  event: MatrixEvent,
  roomId: string,
  onMessage: (event: MatrixEvent, roomId: string) => void | Promise<void>,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void }
): Promise<void> {
  // Skip old events (avoid replaying history on initial sync)
  const age = event.unsigned?.age ?? 0;
  if (age > MAX_EVENT_AGE_MS) return;

  // Skip redacted events
  if (event.unsigned?.redacted_because) {
    removeUTDByEventId(event.event_id ?? "");
    return;
  }

  if (event.type === "m.room.encrypted") {
    // Try to decrypt
    try {
      const machine = getMachine();
      const decrypted = await machine.decryptRoomEvent(
        JSON.stringify(event),
        new RoomId(roomId)
      );
      const decryptedEvent = JSON.parse(decrypted.event);

      // Merge decrypted content back
      const fullEvent: MatrixEvent = {
        ...event,
        type: decryptedEvent.type ?? "m.room.message",
        content: decryptedEvent.content ?? {},
      };

      if (fullEvent.type === "m.room.message") {
        await onMessage(fullEvent, roomId);
      }
    } catch (err: any) {
      // UTD — queue for retry
      log?.warn?.(
        `[sync] Failed to decrypt event ${event.event_id}: ${err.message}`
      );
      pushUTD({ event, roomId, queuedAt: Date.now(), retries: 0 });
    }
  } else if (event.type === "m.room.message") {
    // Plaintext message
    await onMessage(event, roomId);
  } else if (event.type === "m.room.redaction") {
    // Remove redacted event from UTD queue
    // Pre-v1.11: `redacts` is a top-level event field
    // v1.11+: moved to `content.redacts`
    const redactsId =
      event.redacts ??
      (event.content as any)?.redacts;
    if (redactsId) removeUTDByEventId(redactsId);
  }
}

// ── UTD Retry ──────────────────────────────────────────────────────────
async function retryUTDQueue(
  onMessage: (event: MatrixEvent, roomId: string) => void | Promise<void>,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void }
): Promise<void> {
  const now = Date.now();
  const toRetry = [...utdQueue];

  for (const entry of toRetry) {
    // Expire old entries
    if (now - entry.queuedAt > UTD_EXPIRE_MS) {
      log?.warn?.(
        `[sync] Giving up on UTD event ${entry.event.event_id} (>1h old)`
      );
      removeUTDByEventId(entry.event.event_id ?? "");
      continue;
    }

    // Skip too-fresh entries (let keys propagate)
    if (now - entry.queuedAt < 500) continue;

    try {
      const machine = getMachine();
      const decrypted = await machine.decryptRoomEvent(
        JSON.stringify(entry.event),
        new RoomId(entry.roomId)
      );
      const decryptedEvent = JSON.parse(decrypted.event);

      removeUTDByEventId(entry.event.event_id ?? "");

      const fullEvent: MatrixEvent = {
        ...entry.event,
        type: decryptedEvent.type ?? "m.room.message",
        content: decryptedEvent.content ?? {},
      };

      if (fullEvent.type === "m.room.message") {
        await onMessage(fullEvent, entry.roomId);
      }
    } catch {
      entry.retries++;
      // Stay in queue for next cycle
    }
  }
}

// ── Soft Logout Handling ───────────────────────────────────────────────
async function handleTokenError(
  err: MatrixApiError,
  opts: SyncLoopOpts,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void }
): Promise<void> {
  if (err.softLogout && opts.password) {
    // Soft logout: KEEP crypto store, re-auth with same device_id
    log?.warn?.("[sync] Soft logout — attempting re-auth with password");
    try {
      const response = await matrixFetch<MatrixLoginResponse>(
        "POST",
        "/_matrix/client/v3/login",
        {
          type: "m.login.password",
          identifier: {
            type: "m.id.user",
            user: opts.userId,
          },
          password: opts.password,
          device_id: opts.deviceName ?? "OpenClaw",
        },
        { noAuth: true }
      );

      // Update access token (already imported statically)
      updateAccessToken(response.access_token);
      log?.info?.("[sync] Re-auth successful, resuming sync");
    } catch (reAuthErr: any) {
      log?.error?.(
        `[sync] Re-auth failed: ${reAuthErr.message}. Stopping sync.`
      );
      throw reAuthErr;
    }
  } else {
    // Hard logout: server DESTROYED the session
    log?.error?.(
      "[sync] Hard logout — server destroyed session. Wiping crypto store."
    );
    // Wipe crypto store
    await closeMachine();
    try {
      fs.rmSync(opts.cryptoStorePath, { recursive: true, force: true });
    } catch {}
    throw new Error("Hard logout: session destroyed by server");
  }
}

// ── Read Receipts ──────────────────────────────────────────────────────
async function sendReadReceipt(
  roomId: string,
  eventId: string
): Promise<void> {
  try {
    await matrixFetch(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      {}
    );
  } catch {
    // Best-effort — don't fail sync for receipt errors
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
