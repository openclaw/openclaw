import { EventEmitter } from "node:events";
import fs from "node:fs";
import "fake-indexeddb/auto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { MatrixError } from "matrix-js-sdk/lib/http-api/errors.js";
import {
  type MatrixClient as MatrixJsSdkClient,
  type MatrixEvent,
  MsgType,
} from "matrix-js-sdk/lib/matrix.js";
import { EventStatus } from "matrix-js-sdk/lib/models/event-status.js";
import { SyncApi, SyncState } from "matrix-js-sdk/lib/sync.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { requestUrl, useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import type { CoreConfig } from "../types.js";
import { SqliteBackedMatrixSyncStore } from "./client/file-sync-store.js";
import { prepareMockMatrixClientStorage } from "./client/shared.test-support.js";
import {
  registerCryptoOneOffInitializationTests,
  registerCryptoShutdownTests,
  registerCryptoStartupAbortTest,
  registerCryptoPeriodicShutdownTest,
} from "./sdk/crypto-persistence.test-support.js";
import { createMatrixCryptoApi } from "./sdk/crypto.test-support.js";
import { MatrixDecryptBridge } from "./sdk/decrypt-bridge.js";
import { registerDecryptRetentionTests } from "./sdk/decrypt-retention.test-support.js";
import {
  FakeMatrixEvent,
  makeDecryptedMessageEvent,
  makeMatrixEvent,
  type MatrixEventDecryptor,
} from "./sdk/event.test-support.js";
import {
  captureRecoveryCacheWrite,
  holdRecoveryKeyPersistence,
  readStoredRecoveryKey,
  seedRecoveryKeyState,
} from "./sdk/recovery-persistence.test-support.js";
import type { MatrixRawEvent } from "./sdk/types.js";

const ROOM = "!room:example.org";
const USER = "@bot:example.org";
const DEVICE = "DEVICE123";
const HOMESERVER = "https://matrix.example.org";

vi.mock("./sdk/joined-room-encryption.js", () => ({
  reconcileJoinedRoomEncryption: vi.fn(async () => undefined),
}));

const createSharedMatrixClientMock = vi.hoisted(() => vi.fn());
const captureReadAuthorityMock = vi.hoisted(() => vi.fn<() => (() => void) | undefined>());
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
    vi.unstubAllEnvs();
  }),
);
const READ_CALLERS = [
  { caller: "legacy", assertReadAuthority: undefined },
  { caller: "host-authorized", assertReadAuthority: () => undefined },
] as const;

// mock-isolation: Shared SDK action fixtures exclude client disk initialization.
vi.mock("./client/create-client.js", () => ({
  createMatrixClient: createSharedMatrixClientMock,
  prepareMatrixClientStorage: prepareMockMatrixClientStorage,
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>()),
  captureChannelReadAuthority: captureReadAuthorityMock,
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("matrix-sdk-state-"));
  captureReadAuthorityMock.mockReset();
});

const requireMatrixJsSdkPackage = createRequire(import.meta.url);

type MatrixSyncApiTestInternals = {
  connectionReturnedResolvers?: ReturnType<typeof createDeferred<boolean>>;
};

function requireMatrixSyncApiTestInternals(syncApi: unknown): MatrixSyncApiTestInternals {
  // SAFETY: the test stub intentionally models the pinned SDK's private resolver field.
  return syncApi as MatrixSyncApiTestInternals;
}

async function expectAbortError(promise: Promise<unknown>) {
  const err = await promise.catch((caught: unknown) => caught);
  expect(err).toBeInstanceOf(Error);
  expect(err).toMatchObject({ message: "Matrix startup aborted", name: "AbortError" });
}
function expectSomeMockCallOptions(
  mock: ReturnType<typeof vi.fn>,
  fields: Record<string, unknown>,
) {
  expect(mock.mock.calls.map(([options]) => options)).toContainEqual(
    expect.objectContaining(fields),
  );
}

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

function clearTestUndiciRuntimeDepsOverride(): void {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
}

function stubRuntimeFetch(fetchImpl: typeof fetch): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: function MockAgent() {},
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: fetchImpl,
  };
}

async function consumeMatrixSecretStorageKey(keyId = "SSSSKEY"): Promise<boolean> {
  const callbacks = (lastCreateClientOpts?.cryptoCallbacks ?? null) as {
    getSecretStorageKey?: (
      params: { keys: Record<string, unknown> },
      name: string,
    ) => Promise<[string, Uint8Array] | null>;
  } | null;
  const result = await callbacks?.getSecretStorageKey?.(
    { keys: { [keyId]: { algorithm: "m.secret_storage.v1.aes-hmac-sha2" } } },
    "m.cross_signing.master",
  );
  return Boolean(result);
}

type TypedClientMembers = {
  startClient: ReturnType<typeof vi.fn<MatrixJsSdkClient["startClient"]>>;
  stopClient: ReturnType<typeof vi.fn<MatrixJsSdkClient["stopClient"]>>;
  initRustCrypto: ReturnType<typeof vi.fn<MatrixJsSdkClient["initRustCrypto"]>>;
  getCrypto: ReturnType<typeof vi.fn<() => unknown>>;
  secretStorage: Pick<
    MatrixJsSdkClient["secretStorage"],
    "getDefaultKeyId" | "getKey" | "checkKey"
  >;
  decryptEventIfNeeded: ReturnType<typeof vi.fn<MatrixEventDecryptor>>;
  syncApi: SyncApi;
};
type MatrixJsClientStub = TypedClientMembers & {
  [
    K in Exclude<keyof ReturnType<typeof createMatrixJsClientMethods>, keyof TypedClientMembers>
  ]: ReturnType<typeof vi.fn>;
} & {
  emit: EventEmitter["emit"];
  on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MatrixJsClientStub;
};

function createMatrixJsClientMethods(client: EventEmitter) {
  const classicSyncStop = vi.fn(() => {
    queueMicrotask(() => {
      client.emit("sync", SyncState.Stopped, SyncState.Syncing, undefined);
    });
  });
  return {
    classicSyncStop,
    syncApi: Object.assign(Object.create(SyncApi.prototype) as SyncApi, {
      getSyncState: vi.fn(() => SyncState.Syncing),
      stop: classicSyncStop,
    }),
    startClient: vi.fn(async () => {
      queueMicrotask(() => {
        client.emit("sync", "PREPARED", null, undefined);
      });
    }),
    stopClient: vi.fn(),
    initRustCrypto: vi.fn(async () => {}),
    getUserId: vi.fn(() => USER),
    getDeviceId: vi.fn(() => DEVICE),
    getJoinedRooms: vi.fn(async () => ({ joined_rooms: [] })),
    getJoinedRoomMembers: vi.fn(async () => ({ joined: {} })),
    getStateEvent: vi.fn(async (_roomId: string, eventType: string) => {
      if (eventType === "m.room.encryption") {
        throw new MatrixError({ errcode: "M_NOT_FOUND", error: "State event not found" }, 404);
      }
      return {};
    }),
    getAccountData: vi.fn(() => undefined),
    getAccountDataFromServer: vi.fn(async () => null),
    setAccountData: vi.fn(async () => {}),
    getRoomIdForAlias: vi.fn(async () => ({ room_id: "!resolved:example.org" })),
    sendMessage: vi.fn(async () => ({ event_id: "$sent" })),
    resendEvent: vi.fn(async () => ({ event_id: "$resent" })),
    sendEvent: vi.fn(async () => ({ event_id: "$sent-event" })),
    sendStateEvent: vi.fn(async () => ({ event_id: "$state" })),
    redactEvent: vi.fn(async () => ({ event_id: "$redact" })),
    getProfileInfo: vi.fn(async () => ({})),
    getDevices: vi.fn(async () => ({
      devices: [{ device_id: DEVICE, display_name: "OpenClaw" }],
    })),
    joinRoom: vi.fn(async () => ({})),
    mxcUrlToHttp: vi.fn(() => null),
    uploadContent: vi.fn(async () => ({ content_uri: "mxc://example/file" })),
    fetchRoomEvent: vi.fn(async () => ({})),
    getEventMapper: vi.fn(
      () => (raw: Partial<MatrixRawEvent>) =>
        new FakeMatrixEvent({
          roomId: raw.room_id ?? "!mapped:example.org",
          eventId: raw.event_id ?? "$mapped",
          sender: raw.sender ?? "@mapped:example.org",
          type: raw.type ?? "m.room.message",
          ts: raw.origin_server_ts ?? Date.now(),
          content: raw.content ?? {},
          stateKey: raw.state_key,
          unsigned: raw.unsigned,
        }),
    ),
    sendTyping: vi.fn(async () => {}),
    getRoom: vi.fn(() => ({ hasEncryptionStateEvent: () => false })),
    getRooms: vi.fn(() => []),
    getCrypto: vi.fn(() => undefined),
    secretStorage: {
      getDefaultKeyId: vi.fn(async () => null),
      getKey: vi.fn(async () => null),
      checkKey: vi.fn(async () => false),
    },
    decryptEventIfNeeded: vi.fn<MatrixEventDecryptor>(async () => {}),
    relations: vi.fn(async () => ({
      originalEvent: null,
      events: [],
      nextBatch: null,
      prevBatch: null,
    })),
  };
}
function createMatrixJsClientStub(): MatrixJsClientStub {
  const client = new EventEmitter();
  return Object.assign(
    client,
    createMatrixJsClientMethods(client),
  ) as unknown as MatrixJsClientStub;
}

function clearMatrixSyncApiForNeverStartedClient(): void {
  (matrixJsClient as { syncApi?: SyncApi }).syncApi = undefined;
}

let matrixJsClient = createMatrixJsClientStub();
let lastCreateClientOpts: Record<string, unknown> | null = null;

vi.mock("matrix-js-sdk/lib/matrix.js", async () => {
  const actual = await vi.importActual<typeof import("matrix-js-sdk/lib/matrix.js")>(
    "matrix-js-sdk/lib/matrix.js",
  );
  return {
    ...actual,
    ClientEvent: {
      Event: "event",
      Room: "Room",
      Sync: "sync",
      SyncUnexpectedError: "sync.unexpectedError",
    },
    MatrixEventEvent: { Decrypted: "decrypted" },
    createClient: vi.fn((opts: Record<string, unknown>) => {
      lastCreateClientOpts = opts;
      return matrixJsClient;
    }),
  };
});

const { encodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key.js");
const { DecryptionFailureCode } = await import("matrix-js-sdk/lib/crypto-api/index.js");
const { calculateKeyCheck, ServerSideSecretStorageImpl, SECRET_STORAGE_ALGORITHM_V1_AES } =
  await import("matrix-js-sdk/lib/secret-storage.js");
const { MatrixClient: BaseMatrixClient } = await import("./sdk.js");
const startedClients = new Set<InstanceType<typeof BaseMatrixClient>>();

class MatrixClient extends BaseMatrixClient {
  protected override registerBridge(): void {
    super.registerBridge();
    startedClients.add(this);
  }
}

function createSdkClient(options: ConstructorParameters<typeof MatrixClient>[2] = {}) {
  return new MatrixClient(HOMESERVER, "token", options);
}

function createLoopbackClient(options: ConstructorParameters<typeof MatrixClient>[2] = {}) {
  return new MatrixClient("http://127.0.0.1:8008", "token", {
    ...options,
    ssrfPolicy: { allowPrivateNetwork: true },
  });
}

function mockEncryptedRoom() {
  matrixJsClient.getRoom.mockReturnValue({ hasEncryptionStateEvent: () => true });
  matrixJsClient.getCrypto.mockReturnValue({ isEncryptionEnabledInRoom: vi.fn(async () => true) });
}

const cryptoPersistenceContext = {
  createSdkClient,
  getMatrixJsClient: () => matrixJsClient,
  getSyncStore: () => lastCreateClientOpts?.store,
  clearMatrixSyncApiForNeverStartedClient,
  tempDirs,
  expectAbortError,
};

function createEncryptedSdkClient() {
  return createSdkClient({ encryption: true });
}

async function createSyncStoreClient(prefix: string) {
  const store = await SqliteBackedMatrixSyncStore.create(tempDirs.make(prefix));
  const client = createSdkClient({ syncStore: store });
  expect(lastCreateClientOpts?.store).toBe(store);
  return { client, store };
}

function getClientEmitter(client: MatrixClient) {
  return (client as unknown as { emitter: EventEmitter }).emitter;
}

async function stopStartedClients(): Promise<void> {
  const clients = [...startedClients];
  startedClients.clear();
  // Retire the client owner before mocks or state disappear; its periodic
  // persistence must not run against the next test's runtime or deleted home.
  await Promise.all(clients.map((client) => client.stopWithoutPersist()));
}

function makeCryptoApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...createMatrixCryptoApi(), ...overrides };
}

function mockCryptoApi(overrides: () => Record<string, unknown>) {
  matrixJsClient.getCrypto = vi.fn(() => makeCryptoApi(overrides()));
}

function makeSecretStorageStatus() {
  return {
    ready: true,
    defaultKeyId: "SSSSKEY",
    secretStorageKeyValidityMap: {
      "m.cross_signing.master": true,
      "m.cross_signing.user_signing": true,
      "m.cross_signing.self_signing": true,
    },
  };
}

function makeBackupApi(version: string, trust: Record<string, unknown> = {}) {
  return {
    getActiveSessionBackupVersion: vi.fn(async () => version),
    getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
    getKeyBackupInfo: vi.fn(async () => makeKeyBackupInfo(version)),
    isKeyBackupTrusted: vi.fn(async () => makeKeyBackupTrust(trust)),
  };
}

function mockCrossSigningPublication(client: MatrixClient, published = true) {
  vi.spyOn(client, "getOwnCrossSigningPublicationStatus").mockResolvedValue({
    userId: USER,
    masterKeyPublished: published,
    selfSigningKeyPublished: published,
    userSigningKeyPublished: published,
    published,
  });
}

function createRecoveryClient(prefix: string) {
  const recoveryKeyPath = makeRecoveryPath(prefix);
  return { client: createSdkClient({ encryption: true, recoveryKeyPath }), recoveryKeyPath };
}

function makeRecoveryPath(prefix: string) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "recovery-key.json");
}

function mockBackupRequest(client: MatrixClient, version?: string) {
  return vi
    .spyOn(client, "doRequest")
    .mockImplementation(async (method, endpoint) =>
      method === "GET" && endpoint.includes("/room_keys/version") && version ? { version } : {},
    );
}

function makeDeviceVerificationStatus(overrides: Record<string, unknown> = {}) {
  return {
    isVerified: () => true,
    localVerified: true,
    crossSigningVerified: true,
    signedByOwner: true,
    ...overrides,
  };
}

function createCryptoSignalClient(prefix: string) {
  const cryptoStateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const client = createSdkClient({
    encryption: true,
    idbSnapshotPath: path.join(cryptoStateDir, "crypto-idb-snapshot.json"),
    cryptoDatabasePrefix: path.basename(cryptoStateDir),
  });
  const delivered: string[] = [];
  const cryptoListeners = new Map<string, (...args: unknown[]) => void>();
  mockCryptoApi(() => ({
    on: vi.fn((eventName: string, listener: (...args: unknown[]) => void) => {
      cryptoListeners.set(eventName, listener);
    }),
    bootstrapSecretStorage: vi.fn(consumeMatrixSecretStorageKey),
  }));
  client.on("room.message", (_roomId, event) => delivered.push(event.type));
  return { client, delivered, cryptoListeners };
}

async function installSecretStorageKey(privateKey: Uint8Array<ArrayBuffer>) {
  const keyInfo = {
    algorithm: SECRET_STORAGE_ALGORITHM_V1_AES,
    name: "Recovery verification fixture",
    passphrase: { algorithm: "m.pbkdf2" as const, iterations: 1, salt: "fixture" },
    ...(await calculateKeyCheck(privateKey)),
  };
  const secretStorage = {
    getDefaultKeyId: vi.fn(async () => "SSSSKEY"),
    getKey: vi.fn<MatrixJsSdkClient["secretStorage"]["getKey"]>(async () => ["SSSSKEY", keyInfo]),
    checkKey: vi.fn<typeof ServerSideSecretStorageImpl.prototype.checkKey>((key, info) =>
      ServerSideSecretStorageImpl.prototype.checkKey(key, info),
    ),
  };
  matrixJsClient.secretStorage = secretStorage;
  return secretStorage;
}

async function writeRecoveryKeyFixture(recoveryKeyPath: string, seed: number): Promise<string> {
  const privateKey = Uint8Array.from({ length: 32 }, (_, i) => i + seed);
  const encoded = encodeRecoveryKey(privateKey);
  if (!encoded) {
    throw new Error("Could not encode the recovery-key fixture");
  }
  await seedRecoveryKeyState(recoveryKeyPath, privateKey, encoded);
  return encoded;
}

function makeKeyBackupInfo(version = "9") {
  return { algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", auth_data: {}, version };
}

function makeKeyBackupTrust(overrides: Record<string, unknown> = {}) {
  return { trusted: true, matchesDecryptionKey: true, ...overrides };
}

function recoveryBytes(seed = 1) {
  return Uint8Array.from({ length: 32 }, (_, i) => i + seed);
}

function verificationApi(device: Record<string, unknown> = {}) {
  return {
    getSecretStorageStatus: vi.fn(async () => makeSecretStorageStatus()),
    getDeviceVerificationStatus: vi.fn(async () => makeDeviceVerificationStatus(device)),
  };
}

async function initializeCrypto(client: MatrixClient) {
  await (
    client as unknown as { ensureCryptoSupportInitialized: () => Promise<void> }
  ).ensureCryptoSupportInitialized();
}

async function installBootstrapSpy(client: MatrixClient, bootstrap: ReturnType<typeof vi.fn>) {
  await initializeCrypto(client);
  (
    client as unknown as { cryptoBootstrapper: { bootstrap: typeof bootstrap } }
  ).cryptoBootstrapper.bootstrap = bootstrap;
}

function bootstrapState(ready: boolean, ownDeviceVerified = ready) {
  return { crossSigningReady: ready, crossSigningPublished: ready, ownDeviceVerified };
}

function makeDecryptFixture(cryptoApi: unknown = {}) {
  const emitMessage = vi.fn();
  const emitFailedDecryption = vi.fn();
  const bridge = new MatrixDecryptBridge({
    client: { getCrypto: () => cryptoApi },
    toRaw: (event) => ({ event_id: event.getId() ?? "" }),
    emitDecryptedEvent: vi.fn(),
    emitMessage,
    emitFailedDecryption,
  });
  type Retry = {
    event: FakeMatrixEvent;
    roomId: string;
    eventId: string;
    attempts: number;
    inFlight: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  };
  const internals = bridge as unknown as {
    decryptRetries: Map<string, Retry>;
    exhaustedDecryptRetries: Map<string, Retry & { exhaustedAt: number }>;
  };
  function exhaust(event: FakeMatrixEvent) {
    internals.exhaustedDecryptRetries.set(`!room:example.org|${event.getId()}`, {
      event,
      roomId: ROOM,
      eventId: event.getId(),
      attempts: 8,
      inFlight: false,
      timer: null,
      exhaustedAt: Date.now(),
    });
  }
  const { decryptRetries } = internals;
  return { bridge, emitMessage, emitFailedDecryption, exhaust, decryptRetries };
}

function makeEncryptedFile(url: string, key = "key", iv = "iv", hash = "hash") {
  return {
    url,
    key: { alg: "A256CTR", key_ops: ["encrypt", "decrypt"], kty: "oct", k: key, ext: true },
    iv,
    hashes: { sha256: hash },
    v: "v2",
  };
}

describe("MatrixClient request hardening", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearTestUndiciRuntimeDepsOverride();
  });

  afterEach(async () => {
    await stopStartedClients();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearTestUndiciRuntimeDepsOverride();
    resetPluginStateStoreForTests();
  });

  it("reads account data through the server-aware SDK path before initial sync", async () => {
    matrixJsClient.getAccountDataFromServer.mockResolvedValue({
      "@alice:example.org": ["!dm:example.org"],
    });
    const client = createSdkClient();
    await expect(client.getAccountData("m.direct")).resolves.toEqual({
      "@alice:example.org": ["!dm:example.org"],
    });
    expect(matrixJsClient.getAccountDataFromServer).toHaveBeenCalledWith("m.direct");
    expect(matrixJsClient.getAccountData).not.toHaveBeenCalled();
  });

  it("uses a conservative token-and-device-scoped transaction identity", async () => {
    const first = new MatrixClient(HOMESERVER, "token-a", { userId: USER, deviceId: DEVICE });
    const second = new MatrixClient(HOMESERVER, "token-b", { userId: USER, deviceId: DEVICE });
    const whoami = { user_id: USER, device_id: DEVICE };
    vi.spyOn(first, "doRequest").mockResolvedValue(whoami);
    vi.spyOn(second, "doRequest").mockResolvedValue(whoami);
    expect(await first.getTransactionScopeId()).not.toBe(await second.getTransactionScopeId());
    await expect(first.getTransactionScopeId()).resolves.toBe(await first.getTransactionScopeId());
  });

  it("preserves persisted encryption settings when the homeserver no longer exposes room state", async () => {
    matrixJsClient.getRoom.mockReturnValue({ hasEncryptionStateEvent: () => false });
    matrixJsClient.getCrypto.mockReturnValue({
      isEncryptionEnabledInRoom: vi.fn(async () => true),
    });
    matrixJsClient.getStateEvent.mockRejectedValue(
      new MatrixError({ errcode: "M_NOT_FOUND", error: "State event not found" }, 404),
    );
    const client = createSdkClient({ encryption: true });
    await expect(client.getMessageWireEventType(ROOM)).resolves.toBe("m.room.encrypted");
    await expect(client.sendMessage(ROOM, { msgtype: "m.text", body: "secret" })).resolves.toBe(
      "$sent",
    );
    expect(matrixJsClient.getStateEvent).not.toHaveBeenCalled();
  });

  it.each([
    new MatrixError({ errcode: "M_UNRECOGNIZED", error: "Endpoint not found" }, 404),
    new MatrixError({ errcode: "M_NOT_FOUND", error: "Malformed proxy response" }, 503),
  ])("fails closed when authoritative room encryption state cannot be verified", async (error) => {
    matrixJsClient.getRoom.mockReturnValue(null);
    matrixJsClient.getStateEvent.mockRejectedValue(error);
    const client = createSdkClient();
    await expect(client.getMessageWireEventType(ROOM)).rejects.toBe(error);
    await expect(client.sendMessage(ROOM, { msgtype: "m.text", body: "secret" })).rejects.toBe(
      error,
    );
    expect(matrixJsClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing SDK room", hasRoom: false, backendEncrypted: true },
    { name: "stale room and crypto state", hasRoom: true, backendEncrypted: false },
  ])("blocks encrypted sends with $name", async ({ hasRoom, backendEncrypted }) => {
    matrixJsClient.getRoom.mockReturnValue(
      hasRoom ? { hasEncryptionStateEvent: () => false } : null,
    );
    matrixJsClient.getCrypto.mockReturnValue({
      isEncryptionEnabledInRoom: vi.fn(async () => backendEncrypted),
    });
    if (hasRoom) {
      matrixJsClient.getStateEvent.mockResolvedValue({ algorithm: "m.megolm.v1.aes-sha2" });
    }
    const client = createEncryptedSdkClient();
    await expect(client.sendMessage(ROOM, { msgtype: "m.text", body: "secret" })).rejects.toThrow(
      /sync/i,
    );
    expect(matrixJsClient.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects unencrypted location thumbnails", async () => {
    mockEncryptedRoom();
    const client = createEncryptedSdkClient();
    await expect(
      client.sendMessage(ROOM, {
        msgtype: MsgType.Location,
        body: "attachment",
        info: { thumbnail_url: "mxc://example/plain-thumbnail" },
      }),
    ).rejects.toThrow(/unencrypted media.*retry/i);
    expect(matrixJsClient.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects unencrypted media sent through the generic event owner", async () => {
    const content = { msgtype: "m.image", body: "photo.png", url: "mxc://example/plain-primary" };
    mockEncryptedRoom();
    const client = createSdkClient({ encryption: true });
    await expect(client.sendEvent(ROOM, "m.room.message", content)).rejects.toThrow(
      /unencrypted media.*retry/i,
    );
    expect(matrixJsClient.sendEvent).not.toHaveBeenCalled();
  });

  it("allows fully encrypted attachments and preserves text URLs in encrypted rooms", async () => {
    mockEncryptedRoom();
    const client = createSdkClient({ encryption: true });
    const encryptedFile = makeEncryptedFile("mxc://example/encrypted");
    await expect(
      client.sendMessage(ROOM, {
        msgtype: "m.image",
        body: "photo.png",
        file: encryptedFile,
        info: { thumbnail_file: encryptedFile },
      }),
    ).resolves.toBe("$sent");
    await expect(
      client.sendMessage(ROOM, {
        msgtype: MsgType.Location,
        body: "Current location",
        geo_uri: "geo:1,2",
        info: { thumbnail_file: encryptedFile },
      }),
    ).resolves.toBe("$sent");
    await expect(
      client.sendMessage(ROOM, {
        msgtype: "m.text",
        body: "custom link",
        url: "https://example.org/custom-text-field",
      }),
    ).resolves.toBe("$sent");
    await expect(client.sendEvent(ROOM, "m.poll.start", { "m.text": "Lunch?" })).resolves.toBe(
      "$sent-event",
    );
  });

  it.each([
    { eventType: "m.room.encrypted", message: /encrypted wire events.*sdk/i },
    { eventType: "m.room.redaction", message: /redaction wire events.*redactEvent/i },
  ])("rejects caller-supplied reserved $eventType wire events", async ({ eventType, message }) => {
    mockEncryptedRoom();
    const client = createSdkClient({ encryption: true });
    await expect(client.sendEvent(ROOM, eventType, { body: "secret" })).rejects.toThrow(message);
    expect(matrixJsClient.sendEvent).not.toHaveBeenCalled();
  });

  it("preserves the dedicated Matrix room-event redaction owner", async () => {
    const client = createSdkClient();
    await expect(client.redactEvent(ROOM, "$target")).resolves.toBe("$redact");
    expect(matrixJsClient.redactEvent).toHaveBeenCalledWith(ROOM, "$target", undefined, undefined);
  });

  it("returns an already-sent durable event without probing current room state", async () => {
    matrixJsClient.getRoom.mockReturnValue({
      hasEncryptionStateEvent: () => false,
      getEventForTxnId: () => ({ status: EventStatus.SENT, getId: () => "$already-sent" }),
    });
    matrixJsClient.getStateEvent.mockRejectedValue(new Error("state unavailable"));
    const client = createSdkClient();
    await expect(
      client.sendMessage(ROOM, { msgtype: "m.text", body: "already delivered" }, "oc_already_sent"),
    ).resolves.toBe("$already-sent");
    expect(matrixJsClient.getStateEvent).not.toHaveBeenCalled();
    expect(matrixJsClient.sendMessage).not.toHaveBeenCalled();
  });

  it("checks encrypted-room readiness before retrying an unsent durable event", async () => {
    matrixJsClient.getRoom.mockReturnValue({
      hasEncryptionStateEvent: () => false,
      getEventForTxnId: () => ({
        status: EventStatus.NOT_SENT,
        getId: () => "~pending",
        getContent: () => ({ msgtype: "m.text", body: "secret" }),
      }),
    });
    matrixJsClient.getStateEvent.mockResolvedValue({ algorithm: "m.megolm.v1.aes-sha2" });
    const client = createSdkClient();
    await expect(
      client.sendMessage(ROOM, { msgtype: "m.text", body: "secret" }, "oc_retry"),
    ).rejects.toThrow(/enable encryption/i);
    expect(matrixJsClient.resendEvent).not.toHaveBeenCalled();
  });

  it("rejects unencrypted attachment references before retrying an unsent encrypted event", async () => {
    matrixJsClient.getRoom.mockReturnValue({
      hasEncryptionStateEvent: () => true,
      getEventForTxnId: () => ({
        status: EventStatus.NOT_SENT,
        getId: () => "~pending",
        getContent: () => ({
          msgtype: "m.image",
          body: "photo.png",
          url: "mxc://example/plain-primary",
        }),
      }),
    });
    matrixJsClient.getCrypto.mockReturnValue({
      isEncryptionEnabledInRoom: vi.fn(async () => true),
    });
    const client = createSdkClient({ encryption: true });
    await expect(
      client.sendMessage(
        ROOM,
        { msgtype: "m.text", body: "caller content cannot replace the pending event" },
        "oc_retry",
      ),
    ).rejects.toThrow(/unencrypted media.*retry/i);
    expect(matrixJsClient.resendEvent).not.toHaveBeenCalled();
  });

  it("runs the durable plan guard after endpoint selection and before the Matrix PUT", async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async () => {
      order.push("put");
      return Response.json({ event_id: "$sent" });
    });
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createLoopbackClient();
    const fetchFn = lastCreateClientOpts?.fetchFn as typeof fetch;
    matrixJsClient.sendMessage = vi.fn(async (roomId, _content, transactionId) => {
      await fetchFn(
        `http://127.0.0.1:8008/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/${transactionId}`,
        { method: "PUT", body: "{}" },
      );
      return { event_id: "$sent" };
    });
    await expect(
      client.sendMessage(
        ROOM,
        { msgtype: "m.text", body: "hello" },
        "oc_transaction",
        async (dispatch) => {
          order.push("guard");
          expect(dispatch).toEqual({
            roomId: ROOM,
            eventType: "m.room.encrypted",
            transactionId: "oc_transaction",
            requestPath:
              "/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.encrypted/oc_transaction",
          });
        },
      ),
    ).resolves.toBe("$sent");
    expect(order).toEqual(["guard", "put"]);
  });

  it("blocks absolute endpoints unless explicitly allowed", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createSdkClient();
    await expect(client.doRequest("GET", "https://matrix.example.org/start")).rejects.toThrow(
      "Absolute Matrix endpoint is blocked by default",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects a guarded fetchFn into matrix-js-sdk", async () => {
    const client = createSdkClient();
    expect(client).toBeInstanceOf(MatrixClient);
    expect(lastCreateClientOpts).toMatchObject({ baseUrl: HOMESERVER, accessToken: "token" });
    const fetchFn = lastCreateClientOpts?.fetchFn as typeof fetch | undefined;
    if (!fetchFn) {
      throw new Error("expected Matrix SDK guarded fetch");
    }
    await expect(fetchFn("http://127.0.0.1/_matrix/client/v3/account/whoami")).rejects.toThrow(
      /private|blocked|not allowed/i,
    );
  });

  it.each([
    { revokeAuthority: true, failNetworkOnce: false },
    { revokeAuthority: false, failNetworkOnce: true },
  ] as const)(
    "settles recovery persistence before secret deletion (revoked: $revokeAuthority, network failure: $failNetworkOnce)",
    async ({ revokeAuthority, failNetworkOnce }) => {
      clearMatrixSyncApiForNeverStartedClient();
      const recoveryKeyPath = path.join(
        tempDirs.make("matrix-recovery-dispatch-"),
        "recovery-key.json",
      );
      const persistence = holdRecoveryKeyPersistence();
      let authorized = true;
      const authorityError = new Error("Matrix read authority expired");
      captureReadAuthorityMock.mockReturnValue(() => {
        if (!authorized) {
          throw authorityError;
        }
      });
      let networkFailurePending = failNetworkOnce;
      let retryTimersInstalled = false;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect((await readStoredRecoveryKey(recoveryKeyPath))?.keyId).toBe("SSSSKEY");
        if (networkFailurePending) {
          networkFailurePending = false;
          // Persistence and the first request stay real; only SDK backoff is virtual.
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout"],
            shouldClearNativeTimers: true,
          });
          retryTimersInstalled = true;
          throw new TypeError("Synthetic network interruption");
        }
        return Response.json(
          init?.method === "GET" && requestUrl(input).includes("m.secret_storage.key.")
            ? { algorithm: "unsupported.synthetic" }
            : {},
        );
      });
      stubRuntimeFetch(fetchMock as typeof fetch);
      const client = new MatrixClient("http://127.0.0.1:8008", "token", {
        userId: USER,
        encryption: true,
        recoveryKeyPath,
        stateRuntime: persistence.stateRuntime,
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      const { options, getSecretStorageKey } = captureRecoveryCacheWrite(lastCreateClientOpts);
      const sdk = await vi.importActual<typeof import("matrix-js-sdk/lib/matrix.js")>(
        "matrix-js-sdk/lib/matrix.js",
      );
      const sdkClient = sdk.createClient(options);
      const accountDataRequest = vi.spyOn(sdkClient.http, "authedRequest");
      let operationSettled: Promise<PromiseSettledResult<void>[]> | undefined;
      let outcome: PromiseSettledResult<void> | undefined;
      let retryDriver: Promise<void> | undefined;
      try {
        await persistence.admitted.promise;
        const pending = sdkClient.secretStorage.store("m.megolm_backup.v1", null, ["SSSSKEY"]);
        operationSettled = Promise.allSettled([pending]).then((results) => {
          outcome = results[0];
          return results;
        });
        const firstRequest = accountDataRequest.mock.results[0];
        if (firstRequest?.type !== "return") {
          throw new Error("expected the real SDK account-data request");
        }
        if (failNetworkOnce) {
          retryDriver = (async () => {
            await Promise.allSettled([firstRequest.value]);
            await setImmediate();
            if (retryTimersInstalled) {
              await vi.advanceTimersByTimeAsync(2_000);
            }
          })();
          void retryDriver.catch(() => {});
        }
        await setImmediate();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getSecretStorageKey).not.toHaveBeenCalled();
        authorized = !revokeAuthority;
        persistence.release.resolve();
        if (revokeAuthority) {
          await Promise.allSettled([firstRequest.value]);
          await setImmediate();
          // A settled authority rejection must not leave the SDK waiting in network backoff.
          expect(outcome?.status).toBe("rejected");
          await expect(pending).rejects.toThrow(authorityError.message);
          await expect(pending).rejects.toMatchObject({ name: "AbortError" });
          expect(fetchMock).not.toHaveBeenCalled();
        } else {
          await retryDriver;
          await pending;
          const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
          expect(put).toBeDefined();
          const body = put?.[1]?.body;
          if (typeof body !== "string") {
            throw new Error("expected SDK JSON account-data body");
          }
          expect(JSON.parse(body)).toEqual({});
          expect(fetchMock).toHaveBeenCalledTimes(2);
        }
        expect(getSecretStorageKey).not.toHaveBeenCalled();
        expect((await readStoredRecoveryKey(recoveryKeyPath))?.keyId).toBe("SSSSKEY");
      } finally {
        authorized = true;
        persistence.release.resolve();
        try {
          await Promise.allSettled([retryDriver, operationSettled]);
        } finally {
          if (retryTimersInstalled) {
            vi.useRealTimers();
          }
          accountDataRequest.mockRestore();
          sdkClient.stopClient();
          await client.stopWithoutPersist().finally(() => getSecretStorageKey.mockRestore());
        }
      }
    },
  );

  it("falls back to legacy media downloads for older homeservers", async () => {
    const payload = Buffer.from([5, 6, 7, 8]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/_matrix/client/v1/media/download/")) {
        return Response.json(
          { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" },
          { status: 404 },
        );
      }
      return new Response(payload, { status: 200 });
    });
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createLoopbackClient();
    await expect(client.downloadContent("mxc://example.org/media")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(urls[0]).toContain("/_matrix/client/v1/media/download/example.org/media");
    expect(urls[1]).toContain("/_matrix/media/v3/download/example.org/media");
  });

  it("preserves encrypted media download limits through the crypto facade", async () => {
    const payload = Buffer.from([9, 10, 11, 12, 13]);
    const fetchMock = vi.fn(async () => new Response(payload, { status: 200 }));
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createLoopbackClient({ encryption: true });
    await initializeCrypto(client);
    const cryptoFacade = client.crypto;
    if (!cryptoFacade) {
      throw new Error("expected Matrix crypto facade");
    }
    await expect(
      cryptoFacade.decryptMedia(
        makeEncryptedFile("mxc://example.org/encrypted", "unused", "unused", "unused"),
        { maxBytes: 4, readIdleTimeoutMs: 25 },
      ),
    ).rejects.toThrow(/Matrix media exceeds configured size limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("decrypts encrypted room events returned by getEvent", async () => {
    const client = createSdkClient();
    matrixJsClient.fetchRoomEvent = vi.fn(async () => ({
      room_id: ROOM,
      event_id: "$poll",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      origin_server_ts: 1,
      content: {},
    }));
    matrixJsClient.decryptEventIfNeeded = vi.fn(async (event: FakeMatrixEvent) => {
      event.markDecrypted({ type: "m.poll.start", content: { "m.poll.start": {} } });
    });
    const event = await client.getEvent(ROOM, "$poll");
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      event_id: "$poll",
      type: "m.poll.start",
      sender: "@alice:example.org",
    });
  });

  it("orders messages and events within a room without blocking other rooms", async () => {
    const client = createSdkClient();
    const release = createDeferred<void>();
    const started: string[] = [];
    matrixJsClient.sendMessage = vi.fn(async (roomId: string) => {
      started.push(roomId);
      if (roomId === "!room-a:example.org") {
        await release.promise;
      }
      return { event_id: `$${roomId}` };
    });
    matrixJsClient.sendEvent = vi.fn(async () => {
      started.push("event");
      return { event_id: "$event" };
    });
    const first = client.sendMessage("!room-a:example.org", { msgtype: "m.text", body: "a" });
    const queued = client.sendEvent("!room-a:example.org", "m.reaction", {
      "m.relates_to": { event_id: "$target", key: "👍", rel_type: "m.annotation" },
    });
    try {
      await expect(
        client.sendMessage("!room-b:example.org", { msgtype: "m.text", body: "b" }),
      ).resolves.toBe("$!room-b:example.org");
      expect(started).toEqual(["!room-a:example.org", "!room-b:example.org"]);
      expect(matrixJsClient.sendEvent).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([first, queued]);
    }
    await expect(first).resolves.toBe("$!room-a:example.org");
    await expect(queued).resolves.toBe("$event");
    expect(started).toEqual(["!room-a:example.org", "!room-b:example.org", "event"]);
  });

  it("maps relations pages back to raw events", async () => {
    const client = createSdkClient();
    matrixJsClient.relations = vi.fn(async () => ({
      originalEvent: makeMatrixEvent({
        eventId: "$poll",
        type: "m.poll.start",
        ts: 1,
        content: { "m.poll.start": {} },
      }),
      events: [
        makeMatrixEvent({
          eventId: "$vote",
          sender: "@bob:example.org",
          type: "m.poll.response",
          ts: 2,
          content: {
            "m.poll.response": {},
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        }),
      ],
      nextBatch: null,
      prevBatch: null,
    }));
    const page = await client.getRelations(ROOM, "$poll", "m.reference");
    expect(page.originalEvent).toMatchObject({ event_id: "$poll", type: "m.poll.start" });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      event_id: "$vote",
      type: "m.poll.response",
      sender: "@bob:example.org",
    });
  });

  it("awaits untyped relation decryption before projecting effective content", async () => {
    const client = createSdkClient();
    const encrypted = makeMatrixEvent({ type: "m.room.encrypted", content: {} });
    const gate = createDeferred<void>();
    matrixJsClient.relations.mockResolvedValue({ events: [encrypted], nextBatch: null });
    matrixJsClient.decryptEventIfNeeded = vi.fn<(event: FakeMatrixEvent) => Promise<void>>(
      async (event) => {
        await gate.promise;
        event.markDecrypted({
          type: "m.poll.response",
          content: { "m.poll.response": { answers: ["a1"] } },
        });
      },
    );
    let finished = false;
    const result = client.getRelations(ROOM, "$poll", "m.reference").then((page) => {
      finished = true;
      return page;
    });
    await Promise.resolve();
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledWith(encrypted);
    expect(finished).toBe(false);
    gate.resolve();
    const page = await result;
    expect(page.events[0]?.type).toBe("m.poll.response");
    expect(page.events[0]?.content).toEqual({ "m.poll.response": { answers: ["a1"] } });
  });

  it("blocks cross-protocol redirects when absolute endpoints are allowed", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "https://127.0.0.2:8008/next" },
      });
    });
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createLoopbackClient();
    await expect(
      client.doRequest("GET", "http://127.0.0.1:8008/start", undefined, undefined, {
        allowAbsoluteEndpoint: true,
      }),
    ).rejects.toThrow("Blocked cross-protocol redirect");
  });

  it("strips authorization when redirect crosses origin", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (calls.length === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.2:8008/next" },
        });
      }
      return Response.json({});
    });
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createLoopbackClient();
    await client.doRequest("GET", "http://127.0.0.1:8008/start", undefined, undefined, {
      allowAbsoluteEndpoint: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8008/start");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(calls[1]?.url).toBe("http://127.0.0.2:8008/next");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
  });

  it("uses the default request deadline for a NaN timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_: URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    stubRuntimeFetch(fetchMock as unknown as typeof fetch);
    const client = createLoopbackClient({ localTimeoutMs: Number.NaN });
    const assertion = expect(
      client.doRequest("GET", "/_matrix/client/v3/account/whoami"),
    ).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;
  });

  registerCryptoShutdownTests(cryptoPersistenceContext);

  it.each(["persist", "discard"] as const)(
    "joins accepted recovery writes during %s shutdown despite quiesce failure",
    async (mode) => {
      clearMatrixSyncApiForNeverStartedClient();
      const recoveryKeyPath = path.join(
        tempDirs.make("matrix-recovery-stop-"),
        "recovery-key.json",
      );
      const persistence = holdRecoveryKeyPersistence();
      const client = new MatrixClient(HOMESERVER, "token", {
        encryption: true,
        recoveryKeyPath,
        stateRuntime: persistence.stateRuntime,
      });
      const { getSecretStorageKey } = captureRecoveryCacheWrite(lastCreateClientOpts);
      const quiesceError = new Error("synthetic sync quiescence failure");
      const quiesce = vi.spyOn(client, "quiesceSync").mockRejectedValue(quiesceError);
      let shutdownSettled: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await persistence.admitted.promise;
        const shutdown = mode === "persist" ? client.stopAndPersist() : client.stopWithoutPersist();
        let finished = false;
        shutdownSettled = Promise.allSettled([shutdown]).then((outcomes) => {
          finished = true;
          return outcomes;
        });
        await setImmediate();
        expect(quiesce).toHaveBeenCalled();
        expect(finished).toBe(false);
        persistence.release.resolve();
        if (mode === "persist") {
          await expect(shutdown).rejects.toBe(quiesceError);
        } else {
          await expect(shutdown).resolves.toBeUndefined();
        }
        expect(await readStoredRecoveryKey(recoveryKeyPath)).toMatchObject({
          keyId: "SSSSKEY",
          privateKeyBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
        });
      } finally {
        persistence.release.resolve();
        await shutdownSettled;
        quiesce.mockRestore();
        await client.stopWithoutPersist();
        getSecretStorageKey.mockRestore();
      }
    },
  );

  it("single-flights concurrent shutdown after discard starts", async () => {
    clearMatrixSyncApiForNeverStartedClient();
    const { client, store } = await createSyncStoreClient("matrix-sdk-discard-");
    const discardSpy = vi.spyOn(store, "discardPendingSyncCursorPersistence");
    await Promise.all([
      client.stopWithoutPersist(),
      client.stopWithoutPersist(),
      client.stopAndPersist(),
    ]);
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(matrixJsClient.stopClient).toHaveBeenCalledTimes(1);
  });

  it("arms and removes the STOPPED waiter around protected classic sync stop", async () => {
    const client = createSdkClient();
    await client.start();
    const emitter = getClientEmitter(client);
    const listenerCountBefore = emitter.listenerCount("sync.state");
    const syncStop = matrixJsClient.classicSyncStop;
    syncStop.mockImplementation(() => {
      expect(emitter.listenerCount("sync.state")).toBe(listenerCountBefore + 1);
      queueMicrotask(() => {
        matrixJsClient.emit("sync", SyncState.Stopped, SyncState.Syncing, undefined);
      });
    });
    await client.quiesceSync();
    expect(syncStop).toHaveBeenCalledTimes(1);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    expect(emitter.listenerCount("sync.state")).toBe(listenerCountBefore);
  });

  it.each([
    { ...READ_CALLERS[0], syncState: SyncState.Error },
    { ...READ_CALLERS[1], syncState: SyncState.Reconnecting },
  ])(
    "does not replace a retiring $syncState client until transient work releases ($caller caller)",
    async ({ syncState, caller, assertReadAuthority }) => {
      captureReadAuthorityMock.mockReturnValue(assertReadAuthority);
      vi.useFakeTimers();
      const accountId = `sdk-retirement-${syncState.toLowerCase()}-${caller}`;
      const cfg = {
        channels: {
          matrix: {
            defaultAccount: accountId,
            accounts: {
              [accountId]: {
                homeserver: HOMESERVER,
                userId: USER,
                accessToken: "token",
                deviceId: DEVICE,
                encryption: false,
              },
            },
          },
        },
      } satisfies CoreConfig;
      const { resolveMatrixAuth } = await import("./client/config.js");
      const auth = await resolveMatrixAuth({ cfg, accountId });
      const gate = createDeferred<string>();
      const entered = createDeferred<void>();
      const firstClient = new MatrixClient(auth.homeserver, auth.accessToken);
      const firstSdkClient = matrixJsClient;
      let replacementClient: InstanceType<typeof MatrixClient> | undefined;
      let operationOutcome:
        | Promise<{ ok: true; value: string } | { ok: false; error: unknown }>
        | undefined;
      const { acquireSharedMatrixClient, stopSharedClientForAccount } =
        await import("./client/shared.js");
      const { withResolvedRuntimeMatrixClient } = await import("./client-bootstrap.js");
      let replacementLease: Awaited<ReturnType<typeof acquireSharedMatrixClient>> | undefined;
      let replacementAcquisition: ReturnType<typeof acquireSharedMatrixClient> | undefined;
      createSharedMatrixClientMock.mockReset();
      createSharedMatrixClientMock
        .mockResolvedValueOnce(firstClient)
        .mockImplementationOnce(async () => {
          matrixJsClient = createMatrixJsClientStub();
          replacementClient = new MatrixClient(auth.homeserver, auth.accessToken);
          return replacementClient;
        });
      const keepalive = createDeferred<boolean>();
      const keepaliveOutcome = keepalive.promise.then(
        () => "resolved",
        (error: unknown) => error,
      );
      const syncInternals = requireMatrixSyncApiTestInternals(firstSdkClient.syncApi);
      try {
        const monitor = await acquireSharedMatrixClient({ auth, role: "monitor" });
        monitor.registerMonitorRetirement({
          closeTaskAdmission: () => {},
          detachListeners: () => {},
          waitForTasks: async () => {},
          cleanup: async () => {},
        });
        vi.spyOn(firstSdkClient.syncApi, "getSyncState").mockReturnValue(syncState);
        syncInternals.connectionReturnedResolvers = keepalive;
        firstSdkClient.classicSyncStop.mockImplementation(() => {});
        let borrowedClient: unknown;
        let borrowedSignal: AbortSignal | undefined;
        const operation = withResolvedRuntimeMatrixClient(
          { cfg, accountId: auth.accountId, readiness: "none" },
          async (client, abortSignal) => {
            borrowedClient = client;
            borrowedSignal = abortSignal;
            entered.resolve();
            return await gate.promise;
          },
        );
        operationOutcome = operation.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await entered.promise;
        expect(borrowedClient).toBe(firstClient);
        const monitorOutcome = monitor.release({ mode: "persist" }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(firstSdkClient.classicSyncStop).toHaveBeenCalledOnce();
        expect(borrowedSignal?.aborted).toBe(true);
        await expect(keepaliveOutcome).resolves.toBe("SyncApi.stop() was called");
        expect(syncInternals.connectionReturnedResolvers).toBeUndefined();
        expect(createSharedMatrixClientMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(monitorOutcome).resolves.toMatchObject({
          ok: false,
          error: { message: "Matrix client retirement did not settle within 5000ms" },
        });
        replacementAcquisition = acquireSharedMatrixClient({ auth, startClient: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(createSharedMatrixClientMock).toHaveBeenCalledOnce();
        gate.resolve("late-result");
        await expect(operationOutcome).resolves.toEqual({ ok: true, value: "late-result" });
        replacementLease = await replacementAcquisition;
        expect(replacementLease.client).toBe(replacementClient);
        expect(createSharedMatrixClientMock).toHaveBeenCalledTimes(2);
      } finally {
        syncInternals.connectionReturnedResolvers = undefined;
        keepalive.resolve(false);
        gate.resolve("cleanup");
        await operationOutcome?.catch(() => undefined);
        replacementLease ??= await replacementAcquisition?.catch(() => undefined);
        if (replacementLease) {
          clearMatrixSyncApiForNeverStartedClient();
        }
        await replacementLease?.release({ mode: "discard" }).catch(() => undefined);
        await stopSharedClientForAccount(auth).catch(() => undefined);
        createSharedMatrixClientMock.mockReset();
      }
    },
  );

  it("does not clear a keepalive resolver replaced during protected sync stop", async () => {
    const client = createSdkClient();
    await client.start();
    vi.spyOn(matrixJsClient.syncApi, "getSyncState").mockReturnValue(SyncState.Error);
    const captured = createDeferred<boolean>();
    const replacement = createDeferred<boolean>();
    const syncInternals = requireMatrixSyncApiTestInternals(matrixJsClient.syncApi);
    syncInternals.connectionReturnedResolvers = captured;
    matrixJsClient.classicSyncStop.mockImplementation(() => {
      syncInternals.connectionReturnedResolvers = replacement;
      queueMicrotask(() => {
        matrixJsClient.emit("sync", SyncState.Stopped, SyncState.Error, undefined);
      });
    });
    await client.quiesceSync();
    expect(syncInternals.connectionReturnedResolvers).toBe(replacement);
    captured.resolve(false);
    replacement.resolve(false);
    syncInternals.connectionReturnedResolvers = undefined;
  });

  it("stops classic sync created by a partial startup before readiness", async () => {
    const client = createSdkClient();
    const abortController = new AbortController();
    matrixJsClient.startClient.mockImplementation(async () => {});
    const startup = client.start({ abortSignal: abortController.signal });
    await vi.waitFor(() => {
      expect(matrixJsClient.startClient).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    await expectAbortError(startup);
    const syncStop = matrixJsClient.classicSyncStop;
    await client.quiesceSync();
    expect(syncStop).toHaveBeenCalledTimes(1);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
  });

  it("times out active SYNCING quiesce without public stop and discards its cursor", async () => {
    vi.useFakeTimers();
    const { client, store } = await createSyncStoreClient("matrix-sync-timeout-");
    await client.start();
    vi.spyOn(matrixJsClient.syncApi, "getSyncState").mockReturnValue(SyncState.Syncing);
    const syncInternals = requireMatrixSyncApiTestInternals(matrixJsClient.syncApi);
    expect(syncInternals.connectionReturnedResolvers).toBeUndefined();
    const emitter = getClientEmitter(client);
    const discardSpy = vi.spyOn(store, "discardPendingSyncCursorPersistence");
    const listenerCountBefore = emitter.listenerCount("sync.state");
    matrixJsClient.classicSyncStop.mockImplementation(() => {});
    const quiesce = client.quiesceSync();
    const rejection = expect(quiesce).rejects.toThrow(
      "Matrix classic sync did not reach STOPPED within 5000ms",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    const repeatedOutcome = client.quiesceSync().then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(Promise.race([repeatedOutcome, Promise.resolve("pending")])).resolves.toBe(
      "rejected",
    );
    expect(syncInternals.connectionReturnedResolvers).toBeUndefined();
    expect(matrixJsClient.classicSyncStop).toHaveBeenCalledTimes(1);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("sync.state")).toBe(listenerCountBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects missing or non-classic sync implementations", async () => {
    const client = createSdkClient();
    await client.start();
    matrixJsClient.syncApi = {} as SyncApi;
    await expect(client.quiesceSync()).rejects.toThrow(
      "rejected a sliding or unknown matrix-js-sdk sync implementation",
    );
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
  });

  it("fails closed before protected sync access when the runtime SDK version drifts", async () => {
    const manifest = requireMatrixJsSdkPackage("matrix-js-sdk/package.json") as {
      version: string;
    };
    const originalVersion = manifest.version;
    const syncStop = matrixJsClient.classicSyncStop;
    manifest.version = "43.0.1";
    try {
      const client = createSdkClient();
      await expect(client.quiesceSync()).rejects.toThrow(
        "Matrix sync quiesce requires matrix-js-sdk 43.0.0; found 43.0.1",
      );
      expect(syncStop).not.toHaveBeenCalled();
      expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    } finally {
      manifest.version = originalVersion;
    }
  });
});

describe("MatrixClient event bridge", () => {
  beforeEach(() => {
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
  });

  afterEach(async () => {
    await stopStartedClients();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits room.message only after encrypted events decrypt", async () => {
    const client = createSdkClient();
    const messageEvents: Array<{ roomId: string; type: string }> = [];
    client.on("room.message", (roomId, event) => {
      messageEvents.push({ roomId, type: event.type });
    });
    await client.start();
    const encrypted = makeMatrixEvent();
    const decrypted = makeDecryptedMessageEvent();
    matrixJsClient.emit("event", encrypted);
    expect(messageEvents).toHaveLength(0);
    encrypted.emit("decrypted", decrypted);
    // Simulate a second normal event emission from the SDK after decryption.
    matrixJsClient.emit("event", decrypted);
    expect(messageEvents).toEqual([{ roomId: ROOM, type: "m.room.message" }]);
  });

  it("quiesces and drains decrypt retries before stopping the SDK once", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const delivered: string[] = [];
    client.on("room.message", (_roomId, event) => delivered.push(event.type));
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    const decrypted = makeDecryptedMessageEvent();
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.emit("decrypted", decrypted);
    });
    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("missing room key"));
    await client.drainPendingDecryptions("test shutdown");
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
    const lateEncrypted = makeMatrixEvent({ eventId: "$late", decryptionFailure: true });
    matrixJsClient.emit("event", lateEncrypted);
    lateEncrypted.emit("decrypted", lateEncrypted, new Error("late missing room key"));
    await Promise.resolve();
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
    vi.useRealTimers();
    await client.stopAndPersist();
    expect(matrixJsClient.stopClient).toHaveBeenCalledTimes(1);
  });

  it("waits for an SDK decrypt already pending when the event is attached", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const delivered: string[] = [];
    let releaseSdkDecryption: (() => void) | undefined;
    const encrypted = makeMatrixEvent({ eventId: "$pending" });
    const sdkDecryption = new Promise<void>((resolve) => {
      releaseSdkDecryption = () => {
        encrypted.markDecrypted({
          type: "m.room.message",
          content: { msgtype: "m.text", body: "decrypted before shutdown" },
        });
        encrypted.setDecryptionPromise(null);
        encrypted.emit("decrypted", encrypted);
        resolve();
      };
    });
    encrypted.setDecryptionPromise(sdkDecryption);
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });
    await client.start();
    matrixJsClient.emit("event", encrypted);
    let drained = false;
    const drain = client.drainPendingDecryptions("test shutdown").then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(delivered).toHaveLength(0);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    releaseSdkDecryption?.();
    await drain;
    expect(delivered).toEqual(["m.room.message"]);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a never-settling SDK decryption drain", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    let rejectSdkDecryption: ((reason?: unknown) => void) | undefined;
    const encrypted = makeMatrixEvent({ eventId: "$pending" });
    encrypted.setDecryptionPromise(
      new Promise<void>((_, reject) => {
        rejectSdkDecryption = reject;
      }),
    );
    await client.start();
    matrixJsClient.emit("event", encrypted);
    const drain = client.drainPendingDecryptions("test shutdown");
    const rejection = expect(drain).rejects.toThrow(
      "Matrix decryption drain did not finish within 5000ms",
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    rejectSdkDecryption?.(new Error("late SDK decryption failure"));
    await Promise.resolve();
    expect(matrixJsClient.stopClient).not.toHaveBeenCalled();
    await client.stopWithoutPersist();
  });

  it("does not keep retrying terminal historical decryption failures", async () => {
    vi.useFakeTimers();
    const client = createSdkClient();
    const failed: string[] = [];
    client.on("room.failed_decryption", (_roomId, eventValue, error) => {
      failed.push(error.message);
    });
    const encrypted = makeMatrixEvent({
      eventId: "$historical",
      ts: Date.now() - 60_000,
      decryptionFailure: true,
      decryptionFailureReason: DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
    });
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {});
    await client.start();
    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", encrypted, new Error("historical key missing"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toEqual(["historical key missing"]);
    expect(matrixJsClient.decryptEventIfNeeded).not.toHaveBeenCalled();
  });

  it("retries encrypted events that already failed before the bridge attaches", async () => {
    vi.useFakeTimers();
    const client = createEncryptedSdkClient();
    const failed: string[] = [];
    const delivered: string[] = [];
    client.on("room.failed_decryption", (_roomId, eventValue, error) => {
      failed.push(error.message);
    });
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    matrixJsClient.decryptEventIfNeeded = vi.fn(async () => {
      encrypted.markDecrypted({
        type: "m.room.message",
        content: { msgtype: "m.text", body: "hello" },
      });
    });
    await client.start();
    matrixJsClient.emit("event", encrypted);
    expect(failed).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(matrixJsClient.decryptEventIfNeeded).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(["m.room.message"]);
  });

  registerDecryptRetentionTests({ createSdkClient, getMatrixJsClient: () => matrixJsClient });

  it("retries an exhausted missing-key decryption when a crypto key signal arrives", async () => {
    vi.useFakeTimers();
    const { client, delivered, cryptoListeners } = createCryptoSignalClient(
      "matrix-sdk-exhausted-retry-",
    );
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    matrixJsClient.decryptEventIfNeeded = vi.fn(
      async (event: FakeMatrixEvent, options?: { isRetry?: boolean }) => {
        if (!event.shouldAttemptDecryption()) {
          return;
        }
        await event.attemptDecryption(matrixJsClient.getCrypto(), options);
      },
    );
    await client.start();
    try {
      matrixJsClient.emit("event", encrypted);
      encrypted.markDecryptionFailed("missing room key");
      await vi.advanceTimersByTimeAsync(200_000);
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(8);
      const deviceUpdate = cryptoListeners.get(CryptoEvent.DevicesUpdated);
      expect(deviceUpdate).toBeTypeOf("function");
      deviceUpdate?.();
      await Promise.resolve();
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(8);
      encrypted.attemptDecryption.mockClear();
      encrypted.onAttemptDecryption(() => {
        encrypted.markDecrypted({
          type: "m.room.message",
          content: { msgtype: "m.text", body: "hello" },
        });
      });
      const trigger = cryptoListeners.get("crypto.keyBackupDecryptionKeyCached");
      expect(trigger).toBeTypeOf("function");
      trigger?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual(["m.room.message"]);
    } finally {
      await client.stopWithoutPersist();
    }
  });

  it("does not start duplicate retries when crypto signals fire while retry is in-flight", async () => {
    const { client, delivered, cryptoListeners } = createCryptoSignalClient(
      "matrix-sdk-duplicate-retry-",
    );
    const encrypted = makeMatrixEvent({ decryptionFailure: true });
    const decrypted = makeDecryptedMessageEvent();
    const releaseRetryRef: { current?: () => void } = {};
    encrypted.onAttemptDecryption(
      async () =>
        await new Promise<void>((resolve) => {
          releaseRetryRef.current = () => {
            encrypted.emit("decrypted", decrypted);
            resolve();
          };
        }),
    );
    await client.start();
    try {
      matrixJsClient.emit("event", encrypted);
      encrypted.emit("decrypted", encrypted, new Error("missing room key"));
      const trigger = cryptoListeners.get("crypto.keyBackupDecryptionKeyCached");
      expect(trigger).toBeTypeOf("function");
      trigger?.();
      trigger?.();
      await Promise.resolve();
      expect(encrypted.attemptDecryption).toHaveBeenCalledTimes(1);
      releaseRetryRef.current?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(delivered).toEqual(["m.room.message"]);
    } finally {
      await client.stopWithoutPersist();
    }
  });

  it.each(["live event", "startup replay"])("emits own invites from %s", async (source) => {
    const roomId = source === "live event" ? ROOM : "!pending:example.org";
    if (source === "startup replay") {
      matrixJsClient.getRooms = vi.fn(() => [
        { roomId, getMyMembership: () => "invite" },
        { roomId: "!joined:example.org", getMyMembership: () => "join" },
      ]);
    }
    const client = createSdkClient();
    const invites: string[] = [];
    client.on("room.invite", (room) => invites.push(room));
    await client.start();
    if (source === "live event") {
      matrixJsClient.emit(
        "event",
        makeMatrixEvent({
          eventId: "$invite",
          type: "m.room.member",
          stateKey: USER,
          content: { membership: "invite" },
        }),
      );
    }
    expect(invites).toEqual([roomId]);
  });

  it("rejects startup when sync reports an unexpected error before ready", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      const timer = setTimeout(() => {
        matrixJsClient.emit("sync.unexpectedError", new Error("sync exploded"));
      }, 0);
      timer.unref?.();
    });
    const client = createSdkClient();
    await expect(client.start()).rejects.toThrow("sync exploded");
  });

  it("allows transient startup ERROR to recover into PREPARED", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "ERROR", null, new Error("temporary outage"));
        queueMicrotask(() => {
          matrixJsClient.emit("sync", "PREPARED", "ERROR", undefined);
        });
      });
    });
    const client = createSdkClient();
    await expect(client.start()).resolves.toBeUndefined();
  });

  it("rejects structured invalid-token ERROR during startup without waiting for timeout", async () => {
    const invalidToken = Object.assign(new Error("Invalid access token"), {
      statusCode: 401,
      data: { errcode: "M_UNKNOWN_TOKEN" },
    });
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "ERROR", null, { error: invalidToken });
      });
    });
    const client = new MatrixClient(HOMESERVER, "invalid-token");
    await expect(client.start()).rejects.toBe(invalidToken);
  });

  it("aborts before post-ready startup work when shutdown races ready sync", async () => {
    matrixJsClient.startClient = vi.fn(async () => {
      queueMicrotask(() => {
        matrixJsClient.emit("sync", "PREPARED", null, undefined);
      });
    });
    const abortController = new AbortController();
    const client = createSdkClient();
    const bootstrapCryptoSpy = vi.spyOn(
      client as unknown as { bootstrapCryptoIfNeeded: () => Promise<void> },
      "bootstrapCryptoIfNeeded",
    );
    bootstrapCryptoSpy.mockImplementation(async () => {});
    client.on("sync.state", (state) => {
      if (state === "PREPARED") {
        abortController.abort();
      }
    });
    await expectAbortError(client.start({ abortSignal: abortController.signal }));
    expect(bootstrapCryptoSpy).not.toHaveBeenCalled();
  });

  it("times out startup when no ready sync state arrives", async () => {
    vi.useFakeTimers();
    matrixJsClient.startClient = vi.fn(async () => {});
    const client = createSdkClient();
    const startPromise = client.start();
    const startExpectation = expect(startPromise).rejects.toThrow(
      "Matrix client did not reach a ready sync state within 30000ms",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await startExpectation;
  });
});

describe("MatrixClient crypto bootstrapping", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    matrixJsClient = createMatrixJsClientStub();
    lastCreateClientOpts = null;
  });

  afterEach(async () => {
    await stopStartedClients();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });

  registerCryptoStartupAbortTest(cryptoPersistenceContext);

  registerCryptoOneOffInitializationTests(cryptoPersistenceContext, () => {
    captureReadAuthorityMock.mockReturnValue(READ_CALLERS[1].assertReadAuthority);
  });
  it("trusts the own Matrix identity after completed self-verification", async () => {
    const verifyOwnIdentity = vi.fn(async () => ({}));
    const freeOwnIdentity = vi.fn();
    mockCryptoApi(() => ({
      getOwnIdentity: vi.fn(async () => ({
        free: freeOwnIdentity,
        isVerified: () => false,
        verify: verifyOwnIdentity,
      })),
    }));
    const client = createEncryptedSdkClient();
    await client.trustOwnIdentityAfterSelfVerification();
    expect(verifyOwnIdentity).toHaveBeenCalledTimes(1);
    expect(freeOwnIdentity).toHaveBeenCalledTimes(1);
  });

  it("does not force-reset bootstrap automatically when the device has an owner signature but not full trust", async () => {
    matrixJsClient.getCrypto = vi.fn(() => makeCryptoApi());
    const client = createSdkClient({
      encryption: true,
      password: "secret-password", // pragma: allowlist secret
    });
    const bootstrapSpy = vi.fn().mockResolvedValue(bootstrapState(false, true));
    await installBootstrapSpy(client, bootstrapSpy);
    vi.spyOn(client, "getOwnDeviceVerificationStatus").mockResolvedValue({
      encryptionEnabled: true,
      userId: USER,
      deviceId: DEVICE,
      verified: false,
      localVerified: true,
      crossSigningVerified: false,
      signedByOwner: true,
      recoveryKeyStored: false,
      recoveryKeyCreatedAt: null,
      recoveryKeyId: null,
      backupVersion: null,
      serverDeviceKnown: true,
      backup: {
        serverVersion: null,
        activeVersion: null,
        trusted: null,
        matchesDecryptionKey: null,
        decryptionKeyCached: false,
        keyLoadAttempted: false,
        keyLoadError: null,
      },
    });
    await client.start();
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
    expect((bootstrapSpy.mock.calls as unknown[][])[0]?.[1] ?? {}).toEqual({
      allowAutomaticCrossSigningReset: false,
    });
  });

  it("attempts repair bootstrap even when no password is configured", async () => {
    matrixJsClient.getCrypto = vi.fn(() => makeCryptoApi());
    const client = createSdkClient({
      encryption: true,
    });
    const bootstrapSpy = vi
      .fn()
      .mockResolvedValueOnce(bootstrapState(false))
      .mockResolvedValueOnce(bootstrapState(true));
    await installBootstrapSpy(client, bootstrapSpy);
    await client.start();
    expect(bootstrapSpy).toHaveBeenCalledTimes(2);
    expect((bootstrapSpy.mock.calls as unknown[][])[1]?.[1] ?? {}).toEqual({
      forceResetCrossSigning: true,
      allowSecretStorageRecreateWithoutRecoveryKey: true,
      strict: true,
    });
  });

  it("rejects recovery keys when secret-storage metadata cannot authenticate them", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-sdk-test-"));
    const recoveryKeyPath = path.join(tmpDir, "recovery-key.json");
    await seedRecoveryKeyState(recoveryKeyPath, new Uint8Array([1, 2, 3, 4]));
    const checkKey = vi.fn(async () => true);
    Object.assign(matrixJsClient, {
      secretStorage: {
        getDefaultKeyId: vi.fn(async () => "SSSSKEY"),
        getKey: vi.fn(async () => [
          "SSSSKEY",
          { algorithm: "m.secret_storage.v1.aes-hmac-sha2", iv: "authenticated-iv" },
        ]),
        checkKey,
      },
    });
    const client = createSdkClient({ encryption: true, recoveryKeyPath });
    await initializeCrypto(client);
    const bootstrapper = (
      client as unknown as {
        cryptoBootstrapper: {
          deps: { canUnlockSecretStorage: () => Promise<boolean> };
        };
      }
    ).cryptoBootstrapper;
    await expect(bootstrapper.deps.canUnlockSecretStorage()).resolves.toBe(false);
    expect(checkKey).not.toHaveBeenCalled();
  });

  it("passes a custom sync filter to matrix-js-sdk startup", async () => {
    const client = createSdkClient({
      userId: USER,
      syncFilter: { room: { ephemeral: { not_types: ["m.receipt"] } } },
    });
    await client.start();
    const startOpts = matrixJsClient.startClient.mock.calls.at(0)?.[0] as
      | { filter?: { getDefinition?: () => unknown } }
      | undefined;
    expect(startOpts?.filter?.getDefinition?.()).toEqual({
      room: { ephemeral: { not_types: ["m.receipt"] } },
    });
  });

  registerCryptoPeriodicShutdownTest(cryptoPersistenceContext);

  it.each([
    {
      name: "missing device",
      error: null,
      verified: false,
      expected: { deviceId: DEVICE, serverDeviceKnown: false },
    },
    {
      name: "unreadable device list",
      error: new Error("device list unavailable"),
      verified: true,
      expected: {
        verified: true,
        serverDeviceKnown: null,
        backup: {
          serverVersion: null,
          activeVersion: null,
          trusted: null,
          keyLoadAttempted: false,
          keyLoadError: null,
        },
      },
    },
    {
      name: "invalidated token",
      verified: true,
      error: Object.assign(new Error("M_UNKNOWN_TOKEN: access token invalidated"), {
        body: { errcode: "M_UNKNOWN_TOKEN" },
        statusCode: 401,
      }),
      expected: { serverDeviceKnown: false },
    },
  ])("preserves own-device diagnostics for $name", async ({ error, verified, expected }) => {
    matrixJsClient.getDevices = vi.fn(async () => {
      if (error) {
        throw error;
      }
      return { devices: [{ device_id: "OTHERDEVICE" }] };
    });
    mockCryptoApi(() =>
      verified
        ? { getDeviceVerificationStatus: vi.fn(async () => makeDeviceVerificationStatus()) }
        : {},
    );
    const client = createEncryptedSdkClient();
    await client.start();
    expect(await client.getOwnDeviceVerificationStatus()).toMatchObject(expected);
  });

  it("returns degraded verification diagnostics when Matrix SDK status calls stall", async () => {
    const client = createSdkClient({ encryption: true, localTimeoutMs: 1 });
    const stall = () => new Promise<never>(() => {});
    vi.spyOn(client, "getRoomKeyBackupStatus").mockImplementation(stall);
    vi.spyOn(client, "getDeviceVerificationStatus").mockImplementation(stall);
    vi.spyOn(client, "listOwnDevices").mockImplementation(stall);
    expect(await client.getOwnDeviceVerificationStatus()).toMatchObject({
      userId: USER,
      deviceId: DEVICE,
      verified: false,
      crossSigningVerified: false,
      backupVersion: null,
      backup: { keyLoadAttempted: false },
      serverDeviceKnown: null,
    });
  });

  it.each([
    { name: "wrong key", seed: 55, accepted: false, rotateDefault: false },
    { name: "default key changed", seed: 1, accepted: false, rotateDefault: true },
  ])(
    "authenticates supplied recovery key against secret-storage MAC: $name",
    async ({ seed, accepted, rotateDefault }) => {
      const privateKey = recoveryBytes(1);
      const secretStorage = await installSecretStorageKey(privateKey);
      if (rotateDefault) {
        secretStorage.checkKey.mockImplementation(async (key, info) => {
          const valid = await ServerSideSecretStorageImpl.prototype.checkKey(key, info);
          secretStorage.getDefaultKeyId.mockResolvedValue("CHANGEDKEY");
          return valid;
        });
      }
      const encoded = encodeRecoveryKey(recoveryBytes(seed));
      expect(encoded).toBeTypeOf("string");
      const bootstrapSecretStorage = vi.fn(consumeMatrixSecretStorageKey);
      const bootstrapCrossSigning = vi.fn(async () => {});
      const checkKeyBackupAndEnable = vi.fn(async () => {});
      const getSecretStorageStatus = vi.fn(async () => makeSecretStorageStatus());
      const getDeviceVerificationStatus = vi.fn(async () => makeDeviceVerificationStatus());
      mockCryptoApi(() => ({
        bootstrapCrossSigning,
        bootstrapSecretStorage,
        getSecretStorageStatus,
        getDeviceVerificationStatus,
        checkKeyBackupAndEnable,
      }));
      const { client } = createRecoveryClient("matrix-sdk-verify-key-");
      const result = await client.verifyWithRecoveryKey(encoded as string);
      expect(result).toMatchObject({
        success: accepted,
        recoveryKeyAccepted: accepted,
        backupUsable: false,
        deviceOwnerVerified: true,
        verified: true,
        recoveryKeyStored: accepted,
      });
      expect(secretStorage.checkKey).toHaveBeenCalledOnce();
      expect(result.deviceId).toBe(DEVICE);
      expect(matrixJsClient.startClient).toHaveBeenCalledTimes(1);
      expect(bootstrapSecretStorage).toHaveBeenCalled();
      expect(bootstrapCrossSigning).toHaveBeenCalled();
      expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts a staged recovery key when it establishes identity trust and backup usability", async () => {
    const privateKey = recoveryBytes(1);
    const encoded = encodeRecoveryKey(privateKey);
    matrixJsClient.secretStorage.getDefaultKeyId = vi.fn(async () => "SSSSKEY");
    let backupKeyLoaded = false;
    mockCryptoApi(() => ({
      bootstrapSecretStorage: vi.fn(consumeMatrixSecretStorageKey),
      getSecretStorageStatus: vi.fn(async () => ({
        ready: true,
        defaultKeyId: "SSSSKEY",
        secretStorageKeyValidityMap: {},
      })),
      getDeviceVerificationStatus: vi.fn(async () => makeDeviceVerificationStatus()),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {
        backupKeyLoaded = await consumeMatrixSecretStorageKey();
      }),
      getActiveSessionBackupVersion: vi.fn(async () => (backupKeyLoaded ? "11" : null)),
      getSessionBackupPrivateKey: vi.fn(async () => (backupKeyLoaded ? privateKey : null)),
      getKeyBackupInfo: vi.fn(async () => makeKeyBackupInfo("11")),
      isKeyBackupTrusted: vi.fn(async () => makeKeyBackupTrust()),
    }));
    const { client, recoveryKeyPath } = createRecoveryClient("matrix-sdk-verify-used-key-");
    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(result).toMatchObject({
      success: true,
      recoveryKeyAccepted: true,
      backupUsable: true,
      deviceOwnerVerified: true,
      recoveryKeyStored: true,
    });
    expect((await readStoredRecoveryKey(recoveryKeyPath))?.encodedPrivateKey).toBe(encoded);
  });

  it("fails recovery-key verification when the device lacks full cross-signing identity trust", async () => {
    const encoded = encodeRecoveryKey(recoveryBytes(1));
    await installSecretStorageKey(recoveryBytes(1));
    mockCryptoApi(() => ({
      bootstrapSecretStorage: vi.fn(consumeMatrixSecretStorageKey),
      ...verificationApi({ crossSigningVerified: false }),
    }));
    const { client } = createRecoveryClient("matrix-sdk-verify-local-only-");
    await client.start();
    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(result).toMatchObject({
      success: false,
      recoveryKeyAccepted: false,
      backupUsable: false,
      deviceOwnerVerified: false,
      verified: false,
    });
    expect(result.error).toContain("full Matrix identity trust");
  });

  it.each([
    { name: "backup uses existing material", keySeed: 55, consumeKey: false },
    { name: "secret storage rejects the key", keySeed: 5, consumeKey: true },
  ])("does not persist a staged recovery key when $name", async ({ keySeed, consumeKey }) => {
    const attemptedEncoded = encodeRecoveryKey(recoveryBytes(55));
    await installSecretStorageKey(recoveryBytes(keySeed));
    mockCryptoApi(() => ({
      ...(consumeKey ? { bootstrapSecretStorage: vi.fn(consumeMatrixSecretStorageKey) } : {}),
      ...verificationApi({ crossSigningVerified: false, signedByOwner: false }),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      ...makeBackupApi("11"),
    }));
    const recoveryKeyPath = makeRecoveryPath("matrix-sdk-verify-unconfirmed-");
    const previousEncoded = await writeRecoveryKeyFixture(recoveryKeyPath, 5);
    const client = createSdkClient({ encryption: true, recoveryKeyPath });
    const result = await client.verifyWithRecoveryKey(attemptedEncoded as string);
    expect(result).toMatchObject({
      success: false,
      recoveryKeyAccepted: false,
      backupUsable: true,
    });
    const persisted = await readStoredRecoveryKey(recoveryKeyPath);
    expect(persisted?.encodedPrivateKey).toBe(previousEncoded);
  });

  it("returns recovery-key diagnostics without bootstrapping when backup is already usable", async () => {
    const bootstrapCrossSigning = vi.fn(async () => {
      throw new Error("bootstrap should not run");
    });
    mockCryptoApi(() => ({
      bootstrapCrossSigning,
      getSecretStorageStatus: vi.fn(async () => makeSecretStorageStatus()),
      getDeviceVerificationStatus: vi.fn(async () =>
        makeDeviceVerificationStatus({
          isVerified: () => false,
          localVerified: false,
          crossSigningVerified: false,
          signedByOwner: false,
        }),
      ),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      ...makeBackupApi("11"),
    }));
    const recoveryKeyPath = makeRecoveryPath("matrix-sdk-verify-restored-");
    const encoded = await writeRecoveryKeyFixture(recoveryKeyPath, 1);
    const client = createSdkClient({ encryption: true, recoveryKeyPath });
    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      recoveryKeyAccepted: true,
      backupUsable: true,
      deviceOwnerVerified: false,
    });
    expect(result.error).toContain("full Matrix identity trust");
  });

  it("fails recovery-key verification when backup remains untrusted after device verification", async () => {
    const encoded = encodeRecoveryKey(recoveryBytes(1));
    await installSecretStorageKey(recoveryBytes(1));
    mockCryptoApi(() => ({
      bootstrapSecretStorage: vi.fn(consumeMatrixSecretStorageKey),
      ...verificationApi(),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      ...makeBackupApi("11", { trusted: false, matchesDecryptionKey: true }),
    }));
    const { client, recoveryKeyPath } = createRecoveryClient("matrix-sdk-verify-untrusted-");
    const result = await client.verifyWithRecoveryKey(encoded as string);
    expect(result).toMatchObject({
      success: false,
      recoveryKeyAccepted: true,
      backupUsable: false,
      deviceOwnerVerified: true,
      verified: true,
    });
    expect(result.error).toContain("backup signature chain is not trusted");
    expect(result.recoveryKeyStored).toBe(false);
    expect(fs.existsSync(recoveryKeyPath)).toBe(false);
  });

  it("does not overwrite the stored recovery key when recovery-key verification fails", async () => {
    const attemptedEncoded = encodeRecoveryKey(recoveryBytes(55));
    mockCryptoApi(() => ({
      bootstrapCrossSigning: vi.fn(async () => {
        throw new Error("secret storage rejected recovery key");
      }),
      getSecretStorageStatus: vi.fn(async () => makeSecretStorageStatus()),
      getDeviceVerificationStatus: vi.fn(async () =>
        makeDeviceVerificationStatus({
          isVerified: () => false,
          localVerified: false,
          crossSigningVerified: false,
          signedByOwner: false,
        }),
      ),
    }));
    const recoveryKeyPath = makeRecoveryPath("matrix-sdk-verify-preserve-");
    const previousEncoded = await writeRecoveryKeyFixture(recoveryKeyPath, 5);
    const client = createSdkClient({ encryption: true, recoveryKeyPath });
    const result = await client.verifyWithRecoveryKey(attemptedEncoded as string);
    expect(result.success).toBe(false);
    expect(result.error).toContain("full Matrix identity trust");
    const persisted = await readStoredRecoveryKey(recoveryKeyPath);
    expect(persisted?.encodedPrivateKey).toBe(previousEncoded);
  });

  it("restores backup keys when the matching decryption key is cached but signature trust is stale", async () => {
    const restoreKeyBackup = vi.fn(async () => ({ imported: 3, total: 3 }));
    mockCryptoApi(() => ({
      ...makeBackupApi("42", { trusted: false, matchesDecryptionKey: true }),
      restoreKeyBackup,
    }));
    const client = createEncryptedSdkClient();
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "42" });
    expect(await client.restoreRoomKeyBackup()).toMatchObject({
      success: true,
      imported: 3,
      total: 3,
      backup: { trusted: false, matchesDecryptionKey: true },
    });
    expect(restoreKeyBackup).toHaveBeenCalledTimes(1);
  });

  it("fails restore when backup key cannot be loaded on this device", async () => {
    mockCryptoApi(() => ({
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {
        throw new Error(
          "loadSessionBackupPrivateKeyFromSecretStorage: missing decryption key in secret storage",
        );
      }),
      getKeyBackupInfo: vi.fn(async () => makeKeyBackupInfo("3")),
      isKeyBackupTrusted: vi.fn(async () =>
        makeKeyBackupTrust({ trusted: true, matchesDecryptionKey: false }),
      ),
    }));
    const client = createEncryptedSdkClient();
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "3" });
    const result = await client.restoreRoomKeyBackup();
    expect(result.success).toBe(false);
    expect(result.error).toContain("backup decryption key could not be loaded from secret storage");
    expect(result).toMatchObject({ backupVersion: "3", backup: { matchesDecryptionKey: false } });
  });

  it("rotates the recovery key when resetting room-key backup with rotation requested", async () => {
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const bootstrapSecretStorage = vi.fn(
      async (opts?: { createSecretStorageKey?: () => Promise<unknown> }) => {
        await opts?.createSecretStorageKey?.();
      },
    );
    const createRecoveryKeyFromPassphrase = vi.fn(async () => ({
      keyId: "ROTATED",
      keyInfo: { name: "Rotated recovery key" },
      privateKey: recoveryBytes(1),
      encodedPrivateKey: "rotated-key",
    }));
    mockCryptoApi(() => ({
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      createRecoveryKeyFromPassphrase,
      getActiveSessionBackupVersion: vi.fn(async () => "21870"),
      getSessionBackupPrivateKey: vi.fn(async () => new Uint8Array([1])),
      getSecretStorageStatus: vi.fn(async () => ({ ready: true, defaultKeyId: "OLD" })),
      getKeyBackupInfo: vi.fn(async () => makeKeyBackupInfo("21870")),
      isKeyBackupTrusted: vi.fn(async () => makeKeyBackupTrust()),
    }));
    const client = createEncryptedSdkClient();
    mockBackupRequest(client, "21869");
    const result = await client.resetRoomKeyBackup({ rotateRecoveryKey: true });
    expect(result.success).toBe(true);
    expect(createRecoveryKeyFromPassphrase).toHaveBeenCalledTimes(1);
    expectSomeMockCallOptions(bootstrapSecretStorage, {
      setupNewKeyBackup: true,
      setupNewSecretStorage: true,
    });
  });

  it("fails reset when the recreated backup still does not match the local decryption key", async () => {
    mockCryptoApi(() => ({
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      ...makeBackupApi("21868", { trusted: true, matchesDecryptionKey: false }),
    }));
    const client = createEncryptedSdkClient();
    mockBackupRequest(client, "21868");
    const result = await client.resetRoomKeyBackup();
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not have the matching backup decryption key");
    expect(result).toMatchObject({
      createdVersion: "21868",
      backup: { matchesDecryptionKey: false },
    });
  });

  it.each([
    {
      name: "bad MAC without a server backup",
      version: "22001",
      previous: undefined,
      error: "Error decrypting secret m.megolm_backup.v1: bad MAC",
    },
    {
      name: "falsey callback with a server backup",
      version: "22002",
      previous: "22000",
      error: "getSecretStorageKey callback returned falsey",
    },
  ])("forces SSSS recreation for $name", async ({ version, previous, error }) => {
    const bootstrapSecretStorage = vi.fn(async () => {});
    const checkKeyBackupAndEnable = vi.fn(async () => {});
    const loadSessionBackupPrivateKeyFromSecretStorage = vi
      .fn()
      .mockRejectedValueOnce(new Error(error));
    const getSessionBackupPrivateKey = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(new Uint8Array([1]));
    const getActiveSessionBackupVersion = vi.fn<() => Promise<string | null>>(async () => version);
    if (!previous) {
      getActiveSessionBackupVersion.mockResolvedValueOnce(null);
    }
    mockCryptoApi(() => ({
      ...makeBackupApi(version),
      bootstrapSecretStorage,
      checkKeyBackupAndEnable,
      loadSessionBackupPrivateKeyFromSecretStorage,
      getActiveSessionBackupVersion,
      getSessionBackupPrivateKey,
    }));
    const client = createEncryptedSdkClient();
    const request = mockBackupRequest(client, previous);
    const result = await client.resetRoomKeyBackup();
    expect(result).toMatchObject({ success: true, createdVersion: version });
    expectSomeMockCallOptions(bootstrapSecretStorage, {
      setupNewKeyBackup: true,
      setupNewSecretStorage: true,
    });
    expect(loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledTimes(1);
    if (!previous) {
      expect(result).toMatchObject({ previousVersion: null, deletedVersion: null });
      expect(
        request.mock.calls.filter(
          ([method, endpoint]) =>
            method === "DELETE" &&
            typeof endpoint === "string" &&
            endpoint.includes("/room_keys/version/"),
        ),
      ).toStrictEqual([]);
    }
  });

  it("reports bootstrap failure when cross-signing keys are not published", async () => {
    mockCryptoApi(() => ({
      isCrossSigningReady: vi.fn(async () => false),
      userHasCrossSigningKeys: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async () => makeDeviceVerificationStatus()),
    }));
    const client = createEncryptedSdkClient();
    mockCrossSigningPublication(client, false);
    const result = await client.bootstrapOwnDeviceVerification();
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Cross-signing bootstrap finished but server keys are still not published",
    );
    expect(matrixJsClient.startClient).toHaveBeenCalledTimes(1);
  });

  it("reports bootstrap failure when the device is only locally trusted", async () => {
    mockCryptoApi(() => ({
      getDeviceVerificationStatus: vi.fn(async () =>
        makeDeviceVerificationStatus({ crossSigningVerified: false, signedByOwner: false }),
      ),
    }));
    const client = createEncryptedSdkClient();
    mockCrossSigningPublication(client);
    const result = await client.bootstrapOwnDeviceVerification();
    expect(result).toMatchObject({
      success: false,
      verification: { localVerified: true, signedByOwner: false },
    });
    expect(result.error).toContain("full Matrix identity trust after bootstrap");
  });

  it("creates a key backup during bootstrap when none exists on the server", async () => {
    const bootstrapSecretStorage = vi.fn(async () => {});
    mockCryptoApi(() => ({
      bootstrapSecretStorage,
      getDeviceVerificationStatus: vi.fn(async () => makeDeviceVerificationStatus()),
      ...makeBackupApi("7"),
    }));
    const client = createEncryptedSdkClient();
    mockCrossSigningPublication(client);
    let backupChecks = 0;
    vi.spyOn(client, "doRequest").mockImplementation(async (_method, endpoint) => {
      if (endpoint.includes("/room_keys/version")) {
        backupChecks += 1;
        return backupChecks >= 2 ? { version: "7" } : {};
      }
      return {};
    });
    const result = await client.bootstrapOwnDeviceVerification();
    expect(result).toMatchObject({ success: true, verification: { backupVersion: "7" } });
    expectSomeMockCallOptions(bootstrapSecretStorage, { setupNewKeyBackup: true });
  });

  it("does not report bootstrap errors when final verification state is healthy", async () => {
    const encoded = encodeRecoveryKey(recoveryBytes(90));
    mockCryptoApi(() => ({ ...verificationApi(), ...makeBackupApi("12") }));
    const client = createEncryptedSdkClient();
    mockCrossSigningPublication(client);
    vi.spyOn(client, "doRequest").mockResolvedValue({ version: "12" });
    const result = await client.bootstrapOwnDeviceVerification({ recoveryKey: encoded as string });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("bounds exhausted decrypt retry rehydration on crypto signals", async () => {
    const { bridge, exhaust } = makeDecryptFixture();
    const events = Array.from({ length: 513 }, (_, index) => {
      const event = makeMatrixEvent({ eventId: "$event-" + index, decryptionFailure: true });
      event.onAttemptDecryption(() => {});
      exhaust(event);
      return event;
    });
    bridge.retryPendingNow({ includeExhausted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(events[0]?.attemptDecryption).not.toHaveBeenCalled();
    expect(events.at(-1)?.attemptDecryption).toHaveBeenCalledTimes(1);
  });

  it("lets an in-flight retry finish during quiesce without rearming it", async () => {
    const { bridge, emitFailedDecryption, emitMessage, decryptRetries } = makeDecryptFixture();
    let release: (() => void) | undefined;
    const event = makeMatrixEvent({ decryptionFailure: true });
    event.onAttemptDecryption(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            event.emit("decrypted", event, new Error("still missing"));
            resolve();
          };
        }),
    );
    decryptRetries.set("!room:example.org|$event", {
      event,
      roomId: ROOM,
      eventId: "$event",
      attempts: 1,
      inFlight: false,
      timer: null,
    });
    const drain = bridge.drainPendingDecryptions("test shutdown");
    await Promise.resolve();
    release?.();
    await drain;
    expect(emitFailedDecryption).not.toHaveBeenCalled();
    expect(emitMessage).not.toHaveBeenCalled();
    expect(decryptRetries.size).toBe(0);
  });

  it("blocks new encrypted events and crypto retry resurrection after quiescing", async () => {
    const listeners = new Map<string, () => void>();
    const cryptoApi = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    const { bridge, emitMessage, exhaust } = makeDecryptFixture(cryptoApi);
    const exhausted = makeMatrixEvent({ eventId: "$exhausted", decryptionFailure: true });
    exhaust(exhausted);
    bridge.bindCryptoRetrySignals(cryptoApi);
    await bridge.drainPendingDecryptions("test shutdown");
    listeners.get(CryptoEvent.KeyBackupDecryptionKeyCached)?.();
    const late = makeMatrixEvent({ eventId: "$late" });
    bridge.attachEncryptedEvent(late as unknown as MatrixEvent, ROOM);
    late.emit("decrypted", late);
    await Promise.resolve();
    expect(exhausted.attemptDecryption).not.toHaveBeenCalled();
    expect(emitMessage).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
