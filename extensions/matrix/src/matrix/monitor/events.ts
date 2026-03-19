import type { PluginRuntime, RuntimeLogger } from "../../runtime-api.js";
import type { CoreConfig } from "../../types.js";
import type { MatrixAuth } from "../client.js";
import { formatMatrixEncryptedEventDisabledWarning } from "../encryption-guidance.js";
import type { MatrixClient } from "../sdk.js";
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
  directTracker?: {
    invalidateRoom: (roomId: string) => void;
  };
  logVerboseMessage: (message: string) => void;
  warnedEncryptedRooms: Set<string>;
  warnedCryptoMissingRooms: Set<string>;
  logger: RuntimeLogger;
  formatNativeDependencyHint: PluginRuntime["system"]["formatNativeDependencyHint"];
  onRoomMessage: (roomId: string, event: MatrixRawEvent) => void | Promise<void>;
}): void {
  const {
    cfg,
    client,
    auth,
    directTracker,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    formatNativeDependencyHint,
    onRoomMessage,
  } = params;
  const { routeVerificationEvent, routeVerificationSummary } = createMatrixVerificationEventRouter({
    client,
    logVerboseMessage,
  });

  client.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    if (routeVerificationEvent(roomId, event)) {
      return;
    }
    void onRoomMessage(roomId, event);
  });

  client.on("room.encrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: encrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on("room.decrypted_event", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: decrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });

  client.on(
    "room.failed_decryption",
    async (roomId: string, event: MatrixRawEvent, error: Error) => {
      const selfUserId = await resolveMatrixSelfUserId(client, logVerboseMessage);
      const sender = typeof event.sender === "string" ? event.sender : null;
      const senderMatchesOwnUser = Boolean(selfUserId && sender && selfUserId === sender);
      logger.warn("Failed to decrypt message", {
        roomId,
        eventId: event.event_id,
        sender,
        senderMatchesOwnUser,
        error: error.message,
      });
      if (senderMatchesOwnUser) {
        logger.warn(formatMatrixSelfDecryptionHint(auth.accountId), {
          roomId,
          eventId: event.event_id,
          sender,
        });
      }
      logVerboseMessage(
        `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`,
      );
    },
  );

  client.on("verification.summary", (summary) => {
    void routeVerificationSummary(summary);
  });

  client.on("room.invite", (roomId: string, event: MatrixRawEvent) => {
    directTracker?.invalidateRoom(roomId);
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const isDirect = (event?.content as { is_direct?: boolean } | undefined)?.is_direct === true;
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
      void onRoomMessage(roomId, event);
      return;
    }

    routeVerificationEvent(roomId, event);
  });
}
