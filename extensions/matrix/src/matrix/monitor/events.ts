// Matrix plugin module implements events behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { PluginRuntime, RuntimeLogger } from "../../runtime-api.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import { formatMatrixEncryptedEventDisabledWarning } from "../encryption-guidance.js";
import type { MatrixClient } from "../sdk.js";
import {
  createMatrixE2eeHealthTracker,
  formatMatrixE2eeCohortOverflowHint,
  formatMatrixE2eeDegradationHint,
  MATRIX_E2EE_DEGRADED_COHORT_LIMIT,
} from "./e2ee-health.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";
import { createMatrixVerificationEventRouter } from "./verification-events.js";

function formatMatrixSelfDecryptionHint(accountId: string): string {
  return (
    "matrix: failed to decrypt a message from this same Matrix user. " +
    "This usually means another Matrix device did not share the room key, or another OpenClaw runtime is using the same account. " +
    `Check 'openclaw matrix verify status --verbose --account ${accountId}' and 'openclaw matrix devices list --account ${accountId}'.`
  );
}

async function resolveMatrixSelfUserId(
  client: MatrixClient,
  logVerboseMessage: (message: string) => void,
): Promise<string | null> {
  if (typeof client.getUserId !== "function") {
    return null;
  }
  try {
    return (await client.getUserId()) ?? null;
  } catch (err) {
    logVerboseMessage(`matrix: failed resolving self user id for decrypt warning: ${String(err)}`);
    return null;
  }
}

export function registerMatrixMonitorEvents(params: {
  cfg: CoreConfig;
  client: MatrixClient;
  auth: MatrixAuth;
  allowFrom: string[];
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  readStoreAllowFrom: () => Promise<string[]>;
  directTracker?: {
    invalidateRoom: (roomId: string) => void;
    rememberInvite?: (roomId: string, remoteUserId: string) => void;
  };
  logVerboseMessage: (message: string) => void;
  warnedEncryptedRooms: Set<string>;
  warnedCryptoMissingRooms: Set<string>;
  logger: RuntimeLogger;
  startupGraceMs?: number;
  getHealthySyncSinceMs?: () => number | undefined;
  onE2eeDegraded?: (error: string) => void;
  onE2eeRecovered?: () => void;
  formatNativeDependencyHint: PluginRuntime["system"]["formatNativeDependencyHint"];
  onRoomMessage: (roomId: string, event: MatrixRawEvent) => void | Promise<void>;
  runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
  sasNoticeRetryDelayMs?: number;
}): void {
  const {
    cfg,
    client,
    auth,
    allowFrom,
    dmEnabled,
    dmPolicy,
    readStoreAllowFrom,
    directTracker,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    startupGraceMs,
    getHealthySyncSinceMs,
    onE2eeDegraded,
    onE2eeRecovered,
    formatNativeDependencyHint,
    onRoomMessage,
    runDetachedTask,
    sasNoticeRetryDelayMs,
  } = params;
  const postHealthySyncDecryptFailureTracker = createMatrixE2eeHealthTracker({
    getHealthySyncSinceMs,
    startupGraceMs,
  });
  const { routeVerificationEvent, routeVerificationSummary } = createMatrixVerificationEventRouter({
    client,
    allowFrom,
    dmEnabled,
    dmPolicy,
    readStoreAllowFrom,
    logVerboseMessage,
    runDetachedTask,
    sasNoticeRetryDelayMs,
  });

  const runMonitorTask = (label: string, task: () => Promise<void>) => {
    if (runDetachedTask) {
      return runDetachedTask(label, task);
    }
    return Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        logVerboseMessage(`matrix: ${label} failed (${String(error)})`);
      });
  };

  client.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    if (routeVerificationEvent(roomId, event)) {
      return;
    }
    void runMonitorTask(
      `room message handler room=${roomId} id=${event.event_id ?? "unknown"}`,
      async () => {
        await onRoomMessage(roomId, event);
      },
    );
  });

  client.on("room.encrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    postHealthySyncDecryptFailureTracker.recordEncryptedEvent(roomId, event);
    logVerboseMessage(`matrix: encrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on("room.decrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: decrypted event room=${roomId} type=${eventType} id=${eventId}`);
    if (
      postHealthySyncDecryptFailureTracker.recordSuccess(
        roomId,
        event,
        event.sender !== auth.userId,
      )
    ) {
      onE2eeRecovered?.();
    }
    if (routeVerificationEvent(roomId, event)) {
      return;
    }
    if (eventType !== EventType.RoomMessage) {
      return;
    }
    void runMonitorTask(
      `decrypted room message handler room=${roomId} id=${event.event_id ?? "unknown"}`,
      async () => {
        await onRoomMessage(roomId, event);
      },
    );
  });

  client.on("room.failed_decryption", (roomId: string, event: MatrixRawEvent, error: Error) => {
    const failureState = postHealthySyncDecryptFailureTracker.recordFailure(
      roomId,
      event,
      error,
      event.sender !== auth.userId,
    );
    const degradationError = failureState.cohortOverflowed
      ? formatMatrixE2eeCohortOverflowHint()
      : failureState.warning
        ? formatMatrixE2eeDegradationHint(auth.accountId)
        : null;
    if (degradationError) {
      onE2eeDegraded?.(degradationError);
    }
    void runMonitorTask(
      `failed decryption handler room=${roomId} id=${event.event_id ?? "unknown"}`,
      async () => {
        const selfUserId = await resolveMatrixSelfUserId(client, logVerboseMessage);
        const sender = typeof event.sender === "string" ? event.sender : null;
        const senderMatchesOwnUser = Boolean(selfUserId && sender && selfUserId === sender);
        logger.warn(
          failureState.freshAfterHealthySync
            ? "Failed to decrypt fresh post-healthy-sync message"
            : "Failed to decrypt message",
          {
            roomId,
            eventId: event.event_id,
            sender,
            senderMatchesOwnUser,
            error: error.message,
            freshAfterHealthySync: failureState.freshAfterHealthySync,
            ...(failureState.freshAfterHealthySync
              ? {
                  postHealthySyncFailureCount: failureState.failureCount,
                }
              : {}),
          },
        );
        if (failureState.warning && degradationError) {
          logger.warn(formatMatrixE2eeDegradationHint(auth.accountId), {
            roomId,
            eventId: event.event_id,
            failureCount: failureState.failureCount,
            roomCount: failureState.warning.roomCount,
            rooms: failureState.warning.rooms,
            senderCount: failureState.warning.senderCount,
            senders: failureState.warning.senders,
            sampleEventIds: failureState.warning.eventIds,
            latestError: failureState.warning.latestError,
            windowMs: failureState.warning.windowMs,
          });
        }
        if (failureState.cohortOverflowed) {
          logger.warn(formatMatrixE2eeCohortOverflowHint(), {
            roomId,
            eventId: event.event_id,
            cohortLimit: MATRIX_E2EE_DEGRADED_COHORT_LIMIT,
          });
        }
        if (senderMatchesOwnUser) {
          logger.warn(formatMatrixSelfDecryptionHint(auth.accountId), {
            roomId,
            eventId: event.event_id,
            sender,
          });
        }
        logVerboseMessage(
          `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} freshAfterHealthySync=${String(failureState.freshAfterHealthySync)} error=${error.message}`,
        );
      },
    );
  });

  client.on("verification.summary", (summary) => {
    void runMonitorTask("verification summary handler", async () => {
      await routeVerificationSummary(summary);
    });
  });

  client.on("room.invite", (roomId: string, event: MatrixRawEvent) => {
    directTracker?.invalidateRoom(roomId);
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const invitee = normalizeOptionalString(event?.state_key) ?? "";
    const senderIsInvitee =
      Boolean(invitee) && (normalizeOptionalString(event?.sender) ?? "") === invitee;
    const isDirect = (event?.content as { is_direct?: boolean } | undefined)?.is_direct === true;
    const rememberedSender = normalizeOptionalString(event?.sender);
    if (rememberedSender && !senderIsInvitee) {
      directTracker?.rememberInvite?.(roomId, rememberedSender);
    }
    logVerboseMessage(
      `matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`,
    );
  });

  client.on("room.join", (roomId: string, event: MatrixRawEvent) => {
    directTracker?.invalidateRoom(roomId);
    const eventId = event?.event_id ?? "unknown";
    logVerboseMessage(`matrix: join room=${roomId} id=${eventId}`);
  });

  client.on("room.event", (roomId: string, event: MatrixRawEvent) => {
    const eventType = event?.type ?? "unknown";
    if (eventType === EventType.RoomMessageEncrypted) {
      logVerboseMessage(
        `matrix: encrypted raw event room=${roomId} id=${event?.event_id ?? "unknown"}`,
      );
      if (auth.encryption !== true && !warnedEncryptedRooms.has(roomId)) {
        warnedEncryptedRooms.add(roomId);
        const warning = formatMatrixEncryptedEventDisabledWarning(cfg, auth.accountId);
        logger.warn(warning, { roomId });
      }
      if (auth.encryption === true && !client.crypto && !warnedCryptoMissingRooms.has(roomId)) {
        warnedCryptoMissingRooms.add(roomId);
        const hint = formatNativeDependencyHint({
          packageName: "@matrix-org/matrix-sdk-crypto-nodejs",
          manager: "pnpm",
          downloadCommand: "node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
        });
        const warning = `matrix: encryption enabled but crypto is unavailable; ${hint}`;
        logger.warn(warning, { roomId });
      }
      return;
    }
    if (eventType === EventType.RoomMember) {
      directTracker?.invalidateRoom(roomId);
      const membership = (event?.content as { membership?: string } | undefined)?.membership;
      const stateKey = (event as { state_key?: string }).state_key ?? "";
      logVerboseMessage(
        `matrix: member event room=${roomId} stateKey=${stateKey} membership=${membership ?? "unknown"}`,
      );
    }
    if (eventType === EventType.Reaction) {
      void runMonitorTask(
        `reaction handler room=${roomId} id=${event.event_id ?? "unknown"}`,
        async () => {
          await onRoomMessage(roomId, event);
        },
      );
      return;
    }

    routeVerificationEvent(roomId, event);
  });
}
