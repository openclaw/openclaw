import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hasErrnoCode } from "../../infra/errno.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import {
  isNativeHookRelayBridgeStaleRegistrationError,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import {
  clearNativeHookRelayBridgeRecordsForTests,
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord as readNativeHookRelayBridgeRecordFromStore,
  renewOrRestoreNativeHookRelayBridgeRecord,
  writeNativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-store.js";
import type {
  ActiveNativeHookRelayRegistration,
  InvokeNativeHookRelayParams,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  normalizePositiveInteger,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

export {
  isRetryableNativeHookRelayBridgeLookupError,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";

const { relays, relayBridges, pendingOperations } = nativeHookRelayState;

type InvokeNativeHookRelay = (
  params: InvokeNativeHookRelayParams,
) => Promise<NativeHookRelayProcessResponse>;

type NativeHookRelayBridgeRenewalResult = "renewed" | "unavailable" | "ownership-changed";

type NativeHookRelayBridgeRequestAuth = {
  provider: NativeHookRelayProvider;
  relayId: string;
  token: string;
  registration: ActiveNativeHookRelayRegistration;
  bridge: NativeHookRelayBridgeRegistration;
  invokeRelay: InvokeNativeHookRelay;
};

export function registerNativeHookRelayBridge(
  registration: ActiveNativeHookRelayRegistration,
  stateDbPath: string,
  invokeRelay: InvokeNativeHookRelay,
): NativeHookRelayBridgeRegistration {
  const token = randomUUID();
  const server = createServer();
  const listening = createDeferredCore();
  server.once("listening", listening.resolve);
  server.once("error", listening.reject);
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId: registration.relayId,
    stateDbPath,
    token,
    server,
    ready: listening.promise,
    pending: listening.promise,
    cancelStartup: () =>
      listening.reject(new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR)),
  };
  server.on("request", (req, res) => {
    void handleNativeHookRelayBridgeRequest(req, res, {
      provider: registration.provider,
      relayId: registration.relayId,
      token,
      registration,
      bridge,
      invokeRelay,
    });
  });
  relayBridges.set(registration.relayId, bridge);
  server.on("error", (error) => {
    log.debug("native hook relay bridge server error", { error, relayId: registration.relayId });
  });
  bridge.ready = listening.promise.then(async () => {
    assertNativeHookRelayBridgeCurrent(registration, bridge);
    await pruneNativeHookRelayBridges(stateDbPath);
    assertNativeHookRelayBridgeCurrent(registration, bridge);
    const record = resolveNativeHookRelayBridgeRecord(registration, bridge);
    if (!record) {
      throw new Error("native hook relay bridge server address unavailable");
    }
    await writeNativeHookRelayBridgeRecord({
      record,
      stateDbPath,
      assertCurrent: () => assertNativeHookRelayBridgeCurrent(registration, bridge),
    });
  });
  bridge.pending = bridge.ready;
  retainNativeHookRelayOperation(bridge.relayId, bridge.ready);
  server.listen(0, "127.0.0.1");
  server.unref();
  return bridge;
}

export function retainNativeHookRelayOperation(relayId: string, operation: Promise<void>): void {
  pendingOperations.add(operation);
  void operation.then(
    () => pendingOperations.delete(operation),
    (error: unknown) => {
      pendingOperations.delete(operation);
      log.debug("native hook relay operation failed", { error, relayId });
    },
  );
}

export async function drainNativeHookRelayBridge(bridge: NativeHookRelayBridgeRegistration) {
  let pending: Promise<void>;
  let failure: { error: unknown } | undefined;
  do {
    pending = bridge.pending;
    try {
      await pending;
    } catch (error) {
      failure ??= { error };
    }
  } while (pending !== bridge.pending);
  if (failure) {
    throw failure.error;
  }
}

function assertNativeHookRelayBridgeCurrent(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
): void {
  if (
    relays.get(registration.relayId) !== registration ||
    relayBridges.get(registration.relayId) !== bridge ||
    bridge.closing
  ) {
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }
}

async function pruneNativeHookRelayBridges(stateDbPath: string): Promise<void> {
  // Liveness checks stay outside the write transaction. The store rereads each
  // authoritative row before deletion so renewal or replacement wins the race.
  try {
    const pruned = await pruneNativeHookRelayBridgeRecords({
      currentPid: process.pid,
      isPidDead: isPidDefinitelyDead,
      stateDbPath,
    });
    for (const row of pruned) {
      log.debug("pruned stale native hook relay bridge record", {
        relayId: row.relayId,
        stalePid: row.pid,
        currentPid: process.pid,
        reason: row.reason,
      });
    }
  } catch (error) {
    log.debug("native hook relay bridge record prune skipped", { error });
  }
}

function resolveNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs = registration.expiresAtMs,
): NativeHookRelayBridgeRecord | undefined {
  const address = bridge.server.address();
  if (!address || typeof address === "string") {
    log.debug("native hook relay bridge server address unavailable", {
      relayId: registration.relayId,
    });
    return undefined;
  }
  return {
    relayId: registration.relayId,
    pid: process.pid,
    hostname: "127.0.0.1",
    port: address.port,
    token: bridge.token,
    expiresAtMs,
  };
}

export async function renewNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs: number,
): Promise<NativeHookRelayBridgeRenewalResult> {
  // Keep each rejection observable without poisoning a later eligible renewal.
  const renewal = bridge.pending
    .catch(() => undefined)
    .then<NativeHookRelayBridgeRenewalResult>(async () => {
      assertNativeHookRelayBridgeCurrent(registration, bridge);
      const record = resolveNativeHookRelayBridgeRecord(registration, bridge, expiresAtMs);
      if (!record) {
        return "unavailable";
      }
      return (await renewOrRestoreNativeHookRelayBridgeRecord({
        record,
        stateDbPath: bridge.stateDbPath,
        assertCurrent: () => assertNativeHookRelayBridgeCurrent(registration, bridge),
      }))
        ? "renewed"
        : "ownership-changed";
    });
  bridge.pending = renewal.then(() => undefined);
  retainNativeHookRelayOperation(bridge.relayId, bridge.pending);
  return await renewal;
}

export function unregisterNativeHookRelayBridge(
  relayId: string,
  options?: {
    deferListenerCloseMs?: number;
    expectedBridge?: NativeHookRelayBridgeRegistration;
  },
): Promise<void> | undefined {
  const bridge = options?.expectedBridge ?? relayBridges.get(relayId);
  if (!bridge) {
    return undefined;
  }
  if (bridge.closing) {
    return bridge.closing;
  }
  if (relayBridges.get(relayId) === bridge) {
    relayBridges.delete(relayId);
  }
  if (!bridge.server.listening) {
    bridge.cancelStartup();
  }
  // Stop advertising the retired endpoint before its listener can close.
  // Token-scoped removal cannot delete an already-published successor.
  bridge.closing = bridge.pending
    .catch(() => undefined)
    .then(async () => {
      try {
        await deleteNativeHookRelayBridgeRecordIfOwned({ ...bridge, pid: process.pid });
      } finally {
        const deferListenerCloseMs = normalizePositiveInteger(options?.deferListenerCloseMs, 0);
        if (deferListenerCloseMs > 0) {
          // Captured old locators keep receiving stale-owner rejection during replacement.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, deferListenerCloseMs).unref();
          });
        }
        await new Promise<void>((resolve, reject) => {
          bridge.server.close((error?: Error) => {
            if (error && !hasErrnoCode(error, "ERR_SERVER_NOT_RUNNING")) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      }
    });
  bridge.pending = bridge.closing;
  retainNativeHookRelayOperation(bridge.relayId, bridge.closing);
  return bridge.closing;
}

async function handleNativeHookRelayBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: NativeHookRelayBridgeRequestAuth,
): Promise<void> {
  try {
    if (req.method !== "POST" || req.url !== "/invoke") {
      writeNativeHookRelayBridgeJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${auth.token}`) {
      writeNativeHookRelayBridgeJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      writeNativeHookRelayBridgeJson(res, 410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const body = await readNativeHookRelayBridgeBody(req);
    const payload = readNativeHookRelayBridgePayload(JSON.parse(body));
    if (payload.provider !== auth.provider || payload.relayId !== auth.relayId) {
      writeNativeHookRelayBridgeJson(res, 403, {
        ok: false,
        error: "native hook relay bridge target mismatch",
      });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      writeNativeHookRelayBridgeJson(res, 410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const result = await auth.invokeRelay({ ...payload, requireGeneration: true });
    writeNativeHookRelayBridgeJson(res, 200, { ok: true, result });
  } catch (error) {
    writeNativeHookRelayBridgeJson(
      res,
      isNativeHookRelayBridgeStaleRegistrationError(error) ? 410 : 500,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function isCurrentNativeHookRelayBridgeRequest(auth: NativeHookRelayBridgeRequestAuth): boolean {
  return (
    relays.get(auth.relayId) === auth.registration && relayBridges.get(auth.relayId) === auth.bridge
  );
}

async function readNativeHookRelayBridgeBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES) {
      throw new Error("native hook relay bridge payload too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readNativeHookRelayBridgePayload(value: unknown): InvokeNativeHookRelayParams {
  if (!isJsonObject(value)) {
    throw new Error("native hook relay bridge payload must be an object");
  }
  return {
    provider: value.provider,
    relayId: value.relayId,
    generation: readNonEmptyString(value.generation, "generation"),
    event: value.event,
    rawPayload: value.rawPayload,
  };
}

function writeNativeHookRelayBridgeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function readNativeHookRelayBridgeRecordIfExists(
  relayId: string,
  stateDbPath?: string,
): Promise<NativeHookRelayBridgeRecord | undefined> {
  try {
    return await readNativeHookRelayBridgeRecordFromStore({ relayId, stateDbPath });
  } catch (error) {
    log.debug("failed to read native hook relay bridge record", { error, relayId });
  }
  return undefined;
}

export async function clearNativeHookRelayBridgesForTests(): Promise<void> {
  for (const relayId of relayBridges.keys()) {
    void unregisterNativeHookRelayBridge(relayId);
  }
  while (pendingOperations.size > 0) {
    await Promise.allSettled(pendingOperations);
  }
  await clearNativeHookRelayBridgeRecordsForTests();
}
