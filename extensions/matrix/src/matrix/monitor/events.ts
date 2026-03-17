import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/matrix";
import type { MatrixAuth } from "../client.js";
import { sendReadReceiptMatrix } from "../send.js";
import type { MatrixRawEvent } from "./types.js";
import { EventType } from "./types.js";

// Deduplication cache for Matrix message IDs to prevent duplicate processing
const processedMessageIds = new Map<string, number>();
const MESSAGE_DEDUP_TTL_MS = 30000; // 30 seconds TTL for deduplication entries
const MESSAGE_CACHE_MAX_SIZE = 1000; // Max entries to prevent memory leaks

function isMessageDuplicate(eventId: string): boolean {
  const now = Date.now();
  // Clean up old entries periodically
  if (processedMessageIds.size > MESSAGE_CACHE_MAX_SIZE) {
    for (const [key, timestamp] of processedMessageIds.entries()) {
      if (now - timestamp > MESSAGE_DEDUP_TTL_MS) {
        processedMessageIds.delete(key);
      }
    }
  }

  const lastProcessed = processedMessageIds.get(eventId);
  if (lastProcessed && now - lastProcessed < MESSAGE_DEDUP_TTL_MS) {
    return true;
  }
  processedMessageIds.set(eventId, now);
  return false;
}

const matrixMonitorListenerRegistry = (() => {
  // Prevent duplicate listener registration when both bundled and extension
  // paths attempt to start monitors against the same shared client.
  const registeredClients = new WeakSet<object>();
  return {
    tryRegister(client: object): boolean {
      if (registeredClients.has(client)) {
        return false;
      }
      registeredClients.add(client);
      return true;
    },
  };
})();

function createSelfUserIdResolver(client: Pick<MatrixClient, "getUserId">) {
  let selfUserId: string | undefined;
  let selfUserIdLookup: Promise<string | undefined> | undefined;

  return async (): Promise<string | undefined> => {
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
}

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
  if (!matrixMonitorListenerRegistry.tryRegister(params.client)) {
    params.logVerboseMessage("matrix: skipping duplicate listener registration for client");
    return;
  }

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

  const resolveSelfUserId = createSelfUserIdResolver(client);
  client.on("room.message", (roomId: string, event: MatrixRawEvent) => {
    const eventId = event?.event_id;
    const senderId = event?.sender;

    // Deduplicate messages by event_id to prevent duplicate processing
    if (eventId && isMessageDuplicate(eventId)) {
      logVerboseMessage(`matrix: dropping duplicate message room=${roomId} id=${eventId}`);
      return;
    }

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
