import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk";
import type { MatrixAuth } from "../client.js";
import { sendReadReceiptMatrix } from "../send.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

export function registerMatrixMonitorEvents(params: {
  client: MatrixClient;
  auth: MatrixAuth;
  logVerboseMessage: (message: string) => void;
  warnedEncryptedRooms: Set<string>;
  warnedCryptoMissingRooms: Set<string>;
  logger: RuntimeLogger;
  formatNativeDependencyHint: PluginRuntime["system"]["formatNativeDependencyHint"];
  onRoomMessage: (roomId: string, event: MatrixRawEvent) => void | Promise<void>;
}): void {
  const {
    client,
    auth,
    logVerboseMessage,
    warnedEncryptedRooms,
    warnedCryptoMissingRooms,
    logger,
    formatNativeDependencyHint,
    onRoomMessage,
  } = params;

  let selfUserId: string | undefined;
  let selfUserIdLookup: Promise<string | undefined> | undefined;
  const resolveSelfUserId = async (): Promise<string | undefined> => {
    if (selfUserId) {
      return selfUserId;
    }
    if (!selfUserIdLookup) {
      selfUserIdLookup = client
        .getUserId()
        .then((userId) => {
          selfUserId = userId;
          return userId;
        })
        .catch(() => undefined)
        .finally(() => {
          if (!selfUserId) {
            selfUserIdLookup = undefined;
          }
        });
    }
    return await selfUserIdLookup;
  };
  client.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id;
    const senderId = event?.sender;
    if (eventId && senderId) {
      void (async () => {
        const currentSelfUserId = await resolveSelfUserId();
        if (!currentSelfUserId || senderId === currentSelfUserId) {
          return;
        }
        await sendReadReceiptMatrix(roomId, eventId, client).catch((err) => {
          logVerboseMessage(
            `matrix: early read receipt failed room=${roomId} id=${eventId}: ${String(err)}`,
          );
        });
      })();
    }

    onRoomMessage(roomId, event);
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
      logger.warn("Failed to decrypt message", {
        roomId,
        eventId: event.event_id,
        error: error.message,
      });
      logVerboseMessage(
        `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`,
      );
    },
  );

  client.on("room.invite", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const isDirect = (event?.content as { is_direct?: boolean } | undefined)?.is_direct === true;
    logVerboseMessage(
      `matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`,
    );
  });

  client.on("room.join", (roomId: string, event: MatrixRawEvent) => {
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
        const warning =
          "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt";
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
      const membership = (event?.content as { membership?: string } | undefined)?.membership;
      const stateKey = (event as { state_key?: string }).state_key ?? "";
      logVerboseMessage(
        `matrix: member event room=${roomId} stateKey=${stateKey} membership=${membership ?? "unknown"}`,
      );
    }
  });
}
