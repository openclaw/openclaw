import type { EventEmitter } from "node:events";
import type { MatrixClient } from "matrix-js-sdk/lib/matrix.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitMatrixStartupWithAbort } from "../startup-abort.js";
import type { MatrixSyncState } from "../sync-state.js";
import { noop } from "./logger.js";
import { withMatrixSendCurrentness } from "./send-currentness.js";

type MatrixLiveSyncSnapshot = {
  state: MatrixSyncState | null;
  fromCache: boolean;
};

type MatrixLiveEncryptedRoomParams = {
  client: MatrixClient;
  emitter: EventEmitter;
  roomId: string;
  assertActive: () => void;
  getSync: () => MatrixLiveSyncSnapshot;
};

export async function withMatrixLiveEncryptedRoom<T>(
  owner: object,
  run: (assertCurrent: () => void) => Promise<T>,
  params: MatrixLiveEncryptedRoomParams & {
    generationSignal: AbortSignal;
    abortSignal?: AbortSignal;
    initializeCrypto: () => Promise<void>;
    operations: Set<Promise<() => void>>;
  },
): Promise<T> {
  const signal = AbortSignal.any([
    params.generationSignal,
    ...(params.abortSignal ? [params.abortSignal] : []),
  ]);
  const active = (async () => {
    signal.throwIfAborted();
    params.assertActive();
    // Initialization belongs to the generation; this waiter's cancellation
    // must not cancel initialization needed by a sibling.
    await params.initializeCrypto();
    signal.throwIfAborted();
    params.assertActive();
    return await probeMatrixLiveEncryptedRoom({ ...params, signal });
  })();
  // QA owns the admitted callback; joining only readiness avoids a stop/operation self-join.
  params.operations.add(active);
  void active.finally(() => params.operations.delete(active)).catch(noop);
  // STOPPED ends the caller's wait, not the owned non-abortable probe.
  const stopped = createDeferred<never>();
  const onSyncState = (state: MatrixSyncState | null) => {
    if (state === "STOPPED") {
      stopped.reject(new Error("Matrix sync stopped while waiting for a live encrypted room"));
    }
  };
  params.emitter.on("sync.state", onSyncState);
  let assertCurrent: () => void;
  try {
    onSyncState(params.getSync().state);
    assertCurrent = await Promise.race([
      awaitMatrixStartupWithAbort(active, signal),
      stopped.promise,
    ]);
  } finally {
    params.emitter.off("sync.state", onSyncState);
  }
  assertCurrent();
  return await withMatrixSendCurrentness(owner, assertCurrent, () => run(assertCurrent));
}

async function probeMatrixLiveEncryptedRoom(
  params: MatrixLiveEncryptedRoomParams & { signal: AbortSignal },
): Promise<() => void> {
  let changed: boolean;
  let wake: (() => void) | undefined;
  const onChange = () => {
    changed = true;
    wake?.();
  };
  const assertActive = () => {
    params.signal.throwIfAborted();
    params.assertActive();
    if (params.getSync().state === "STOPPED") {
      throw new Error("Matrix sync stopped while waiting for a live encrypted room");
    }
  };
  const events = ["sync.state", "room.event", "room.join"];
  for (const event of events) {
    params.emitter.on(event, onChange);
  }
  params.signal.addEventListener("abort", onChange);
  try {
    for (;;) {
      changed = false;
      assertActive();
      const room = params.client.getRoom(params.roomId);
      const crypto = params.client.getCrypto();
      const isCurrent = () => {
        const current = params.getSync();
        return (
          !current.fromCache &&
          (current.state === "PREPARED" || current.state === "SYNCING") &&
          room != null &&
          params.client.getRoom(params.roomId) === room &&
          room.getMyMembership() === "join" &&
          room.hasEncryptionStateEvent() &&
          crypto != null &&
          params.client.getCrypto() === crypto
        );
      };
      if (isCurrent() && crypto) {
        // This SDK probe is not abortable. The client owns it through settlement;
        // a canceled waiter must not let shutdown destroy its crypto backend.
        const encrypted = await crypto.isEncryptionEnabledInRoom(params.roomId);
        assertActive();
        if (!isCurrent()) {
          continue;
        }
        if (encrypted) {
          return () => {
            assertActive();
            if (!isCurrent()) {
              throw new Error("Matrix live encrypted room changed before dispatch; retry the send");
            }
          };
        }
      }
      if (!changed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    }
  } finally {
    for (const event of events) {
      params.emitter.off(event, onChange);
    }
    params.signal.removeEventListener("abort", onChange);
  }
}
