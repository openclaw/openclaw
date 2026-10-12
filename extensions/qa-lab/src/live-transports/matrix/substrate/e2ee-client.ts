import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  EncryptedFile,
  MatrixClient,
  MatrixRawEvent,
  MatrixVerificationBootstrapResult,
  MatrixVerificationSummary,
  MessageEventContent,
} from "@openclaw/matrix/test-api.js";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildMatrixQaMessageContent } from "./client-message-content.js";
import {
  MATRIX_QA_E2EE_SYNC_FILTER,
  createMatrixQaE2eeClientLifecycle,
  createMatrixQaE2eeObservedEventRecorder,
  prepareMatrixQaE2eeStorage,
  type MatrixQaE2eeActorId,
} from "./e2ee-client-internals.js";
import { findMatrixQaObservedEventMatch, normalizeMatrixQaObservedEvent } from "./events.js";
import type { MatrixQaObservedEvent } from "./events.js";

type MatrixQaE2eeRuntime = typeof import("@openclaw/matrix/test-api.js");
type MatrixQaCrypto = NonNullable<MatrixClient["crypto"]>;
const matrixQaStateOwners = new Map<string, { active: boolean }>();

type MatrixQaE2eeClientParams = {
  accessToken: string;
  actorId: MatrixQaE2eeActorId;
  baseUrl: string;
  deviceId?: string;
  outputDir: string;
  password?: string;
  scenarioId: string;
  timeoutMs: number;
  userId: string;
};

export async function loadMatrixQaE2eeRuntime(): Promise<MatrixQaE2eeRuntime> {
  const { loadQaRunnerBundledPluginTestApi } =
    await import("openclaw/plugin-sdk/qa-runner-runtime");
  return loadQaRunnerBundledPluginTestApi<MatrixQaE2eeRuntime>("matrix");
}

async function createMatrixQaE2eeMatrixClient(params: MatrixQaE2eeClientParams) {
  const runtime = await loadMatrixQaE2eeRuntime();
  const { createPluginStateKeyedStoreV2 } =
    await import("openclaw/plugin-sdk/plugin-state-store-runtime");
  const storage = await prepareMatrixQaE2eeStorage({
    actorId: params.actorId,
    outputDir: params.outputDir,
    scenarioId: params.scenarioId,
  });
  const stateDir = path.resolve(storage.accountDir);
  const stateOwner = { active: true };
  matrixQaStateOwners.set(stateDir, stateOwner);
  const closeState = () => {
    stateOwner.active = false;
    if (matrixQaStateOwners.get(stateDir) === stateOwner) {
      matrixQaStateOwners.delete(stateDir);
    }
  };
  runtime.setMatrixRuntime({
    config: {
      current: () => ({}),
      mutateConfigFile: async () => ({}),
      replaceConfigFile: async () => ({}),
    },
    logging: {
      shouldLogVerbose: () => false,
      // Rust crypto debug payloads can contain QR secrets. Keep normal
      // diagnostics without falling back to the SDK's debug console logger.
      getChildLogger: () => ({
        info: (message: string) => console.info(message),
        warn: (message: string) => console.warn(message),
        error: (message: string) => console.error(message),
      }),
    },
    state: {
      resolveStateDir: () => params.outputDir,
      openKeyedStoreV2: <T>(
        options: OpenAsyncKeyedStoreOptions,
        authority?: PluginStateActionAuthority,
      ) => {
        const storeStateDir = path.resolve(options.env?.OPENCLAW_STATE_DIR ?? stateDir);
        const owner = matrixQaStateOwners.get(storeStateDir);
        return createPluginStateKeyedStoreV2<T>(
          "matrix",
          {
            ...options,
            env: {
              ...process.env,
              ...options.env,
              OPENCLAW_STATE_DIR: storeStateDir,
            },
          },
          {
            ...authority,
            assertCurrent: () => {
              if (!owner?.active) {
                throw new Error("Matrix QA E2EE state owner is closed");
              }
              authority?.assertCurrent();
            },
          },
        );
      },
    },
  } as never);
  try {
    const client = new runtime.MatrixClient(params.baseUrl, params.accessToken, {
      autoBootstrapCrypto: false,
      cryptoDatabasePrefix: storage.cryptoDatabasePrefix,
      deviceId: params.deviceId,
      encryption: true,
      idbSnapshotPath: storage.idbSnapshotPath,
      localTimeoutMs: Math.max(10_000, params.timeoutMs),
      password: params.password,
      recoveryKeyPath: storage.recoveryKeyPath,
      ssrfPolicy: { allowPrivateNetwork: true },
      syncStore: await runtime.SqliteBackedMatrixSyncStore.create(
        path.dirname(storage.storagePath),
      ),
      syncFilter: MATRIX_QA_E2EE_SYNC_FILTER,
      userId: params.userId,
    });
    return { client, closeState };
  } catch (error) {
    closeState();
    throw error;
  }
}

export async function createMatrixQaE2eeScenarioClient(
  params: MatrixQaE2eeClientParams & {
    observedEvents: MatrixQaObservedEvent[];
  },
) {
  const { client, closeState } = await createMatrixQaE2eeMatrixClient(params);
  const localEvents: MatrixQaObservedEvent[] = [];
  const verificationSummaries: MatrixVerificationSummary[] = [];
  let primeCursorIndex = 0;
  const cursorIndexByRoom = new Map<string, number>();

  const observedEventRecorder = createMatrixQaE2eeObservedEventRecorder({
    append(event) {
      localEvents.push(event);
      params.observedEvents.push(event);
    },
  });

  const recordEvent = (roomId: string, event: MatrixRawEvent) => {
    observedEventRecorder.record(normalizeMatrixQaObservedEvent(roomId, event));
  };
  client.on("room.message", recordEvent);
  const recordVerificationSummary = (summary: MatrixVerificationSummary) => {
    verificationSummaries.push(summary);
  };
  client.on("verification.summary", recordVerificationSummary);

  const shutdownTimeoutMs = Math.max(1, Math.min(10_000, params.timeoutMs));
  const lifecycle = createMatrixQaE2eeClientLifecycle({
    abortPendingRequests: () => client.abortPendingRequests(),
    detachListeners: () => {
      client.off("room.message", recordEvent);
      client.off("verification.summary", recordVerificationSummary);
    },
    drainPendingDecryptions: () => client.drainPendingDecryptions(),
    shutdownTimeoutMs,
    stopAndPersist: () => client.stopAndPersist().finally(closeState),
    stopWithoutPersist: () => client.stopWithoutPersist().finally(closeState),
  });

  try {
    await client.start({ readyTimeoutMs: Math.min(45_000, Math.max(15_000, params.timeoutMs)) });
  } catch (error) {
    await lifecycle.stop().catch(() => undefined);
    throw error;
  }

  const prime = async () => {
    primeCursorIndex = Math.max(primeCursorIndex, localEvents.length);
    cursorIndexByRoom.clear();
    return `e2ee:${primeCursorIndex}`;
  };
  const waitForOptionalRoomEvent = async (waitParams: {
    predicate: (event: MatrixQaObservedEvent) => boolean;
    roomId: string;
    timeoutMs: number;
  }) => {
    const cursorIndex = cursorIndexByRoom.get(waitParams.roomId) ?? primeCursorIndex;
    const startedAt = Date.now();
    let scanIndex = cursorIndex;
    while (Date.now() - startedAt < waitParams.timeoutMs) {
      const matched = findMatrixQaObservedEventMatch({
        cursorIndex: scanIndex,
        events: localEvents,
        predicate: waitParams.predicate,
        roomId: waitParams.roomId,
      });
      if (matched) {
        const nextCursorIndex = Math.max(cursorIndex, matched.nextCursorIndex);
        cursorIndexByRoom.set(waitParams.roomId, nextCursorIndex);
        return {
          event: matched.event,
          matched: true as const,
          since: `e2ee:${nextCursorIndex}`,
        };
      }
      scanIndex = localEvents.length;
      await sleep(Math.min(250, Math.max(25, waitParams.timeoutMs - (Date.now() - startedAt))));
    }
    const nextCursorIndex = Math.max(cursorIndex, scanIndex);
    cursorIndexByRoom.set(waitParams.roomId, nextCursorIndex);
    return {
      matched: false as const,
      since: `e2ee:${nextCursorIndex}`,
    };
  };

  const requireCrypto = () => {
    if (!client.crypto) {
      throw new Error("Matrix E2EE scenario requires Matrix crypto");
    }
    return client.crypto;
  };
  const runClientOperation = <T>(
    label: string,
    roomId: string,
    run: (assertCurrent: () => void) => Promise<T>,
  ) =>
    lifecycle.runOperation({
      label,
      run: (assertActive) =>
        client.withLiveEncryptedRoom(roomId, run, { assertCurrent: assertActive }),
      timeoutMs: params.timeoutMs,
    });

  return {
    async acceptVerification(id: string) {
      return await requireCrypto().acceptVerification(id);
    },
    bootstrapOwnDeviceVerification: client.bootstrapOwnDeviceVerification.bind(client),
    async confirmVerificationReciprocateQr(id: string) {
      return await requireCrypto().confirmVerificationReciprocateQr(id);
    },
    async confirmVerificationSas(id: string) {
      return await requireCrypto().confirmVerificationSas(id);
    },
    deleteOwnDevices: client.deleteOwnDevices.bind(client),
    async generateVerificationQr(id: string) {
      return await requireCrypto().generateVerificationQr(id);
    },
    getDeviceVerificationStatus: client.getDeviceVerificationStatus.bind(client),
    async getRecoveryKey() {
      return await requireCrypto().getRecoveryKey();
    },
    listOwnDevices: client.listOwnDevices.bind(client),
    async listVerifications() {
      const current = await requireCrypto().listVerifications();
      return [...verificationSummaries, ...current].toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
    },
    prime,
    async waitForJoinedMember(opts: { roomId: string; timeoutMs: number; userId: string }) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < opts.timeoutMs) {
        if (client.hasSyncedJoinedRoomMember(opts.roomId, opts.userId)) {
          return;
        }
        await sleep(Math.min(250, Math.max(25, opts.timeoutMs - (Date.now() - startedAt))));
      }
      throw new Error(
        `Matrix E2EE client did not sync joined membership for ${opts.userId} in ${opts.roomId}`,
      );
    },
    async requestVerification(opts: Parameters<MatrixQaCrypto["requestVerification"]>[0]) {
      return await requireCrypto().requestVerification(opts);
    },
    resetRoomKeyBackup: client.resetRoomKeyBackup.bind(client),
    restoreRoomKeyBackup: client.restoreRoomKeyBackup.bind(client),
    async scanVerificationQr(id: string, qrDataBase64: string) {
      return await requireCrypto().scanVerificationQr(id, qrDataBase64);
    },
    async sendTextMessage(
      opts: Parameters<typeof buildMatrixQaMessageContent>[0] & {
        roomId: string;
      },
    ) {
      return await runClientOperation("Matrix E2EE text send", opts.roomId, () =>
        client.sendMessage(opts.roomId, buildMatrixQaMessageContent(opts) as MessageEventContent),
      );
    },
    async sendNoticeMessage(
      opts: Parameters<typeof buildMatrixQaMessageContent>[0] & {
        roomId: string;
      },
    ) {
      return await runClientOperation("Matrix E2EE notice send", opts.roomId, () =>
        client.sendMessage(opts.roomId, {
          ...buildMatrixQaMessageContent(opts),
          msgtype: "m.notice",
        } as MessageEventContent),
      );
    },
    async sendImageMessage(opts: {
      body: string;
      buffer: Buffer;
      contentType: string;
      fileName: string;
      mentionUserIds?: string[];
      roomId: string;
    }) {
      return await runClientOperation(
        "Matrix E2EE image send",
        opts.roomId,
        async (assertCurrent) => {
          const encrypted = await requireCrypto().encryptMedia(opts.buffer);
          assertCurrent();
          const contentUri = await client.uploadContent(
            encrypted.buffer,
            opts.contentType,
            opts.fileName,
          );
          assertCurrent();
          const file: EncryptedFile = { url: contentUri, ...encrypted.file };
          return await client.sendMessage(opts.roomId, {
            ...buildMatrixQaMessageContent({
              body: opts.body,
              mentionUserIds: opts.mentionUserIds,
            }),
            file,
            filename: opts.fileName,
            info: {
              mimetype: opts.contentType,
              size: opts.buffer.byteLength,
            },
            msgtype: "m.image",
          } as MessageEventContent);
        },
      );
    },
    async startVerification(
      id: string,
      method?: Parameters<MatrixQaCrypto["startVerification"]>[1],
    ) {
      return await requireCrypto().startVerification(id, method);
    },
    stop: lifecycle.stop,
    waitForOptionalRoomEvent,
    async waitForRoomEvent(waitParams: Parameters<typeof waitForOptionalRoomEvent>[0]) {
      const result = await waitForOptionalRoomEvent(waitParams);
      if (result.matched) {
        return {
          event: result.event,
          since: result.since,
        };
      }
      throw new Error(`timed out after ${waitParams.timeoutMs}ms waiting for Matrix E2EE event`);
    },
    verifyWithRecoveryKey: client.verifyWithRecoveryKey.bind(client),
  };
}

export type MatrixQaE2eeScenarioClient = Awaited<
  ReturnType<typeof createMatrixQaE2eeScenarioClient>
>;

export async function runMatrixQaE2eeBootstrap(
  params: MatrixQaE2eeClientParams,
): Promise<MatrixVerificationBootstrapResult> {
  const { client, closeState } = await createMatrixQaE2eeMatrixClient(params);

  try {
    return await client.bootstrapOwnDeviceVerification();
  } finally {
    await client
      .stopAndPersist()
      .finally(closeState)
      .catch(() => undefined);
  }
}
