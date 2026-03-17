import { sendReadReceiptMatrix } from "../send.js";
import { EventType } from "./types.js";
const matrixMonitorListenerRegistry = /* @__PURE__ */ (() => {
  const registeredClients = /* @__PURE__ */ new WeakSet();
  return {
    tryRegister(client) {
      if (registeredClients.has(client)) {
        return false;
      }
      registeredClients.add(client);
      return true;
    }
  };
})();
function createSelfUserIdResolver(client) {
  let selfUserId;
  let selfUserIdLookup;
  return async () => {
    if (selfUserId) {
      return selfUserId;
    }
    if (!selfUserIdLookup) {
      selfUserIdLookup = client.getUserId().then((userId) => {
        selfUserId = userId;
        return userId;
      }).catch(() => void 0).finally(() => {
        if (!selfUserId) {
          selfUserIdLookup = void 0;
        }
      });
    }
    return await selfUserIdLookup;
  };
}
function registerMatrixMonitorEvents(params) {
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
    onRoomMessage
  } = params;
  const resolveSelfUserId = createSelfUserIdResolver(client);
  client.on("room.message", (roomId, event) => {
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
            `matrix: early read receipt failed room=${roomId} id=${eventId}: ${String(err)}`
          );
        });
      })();
    }
    onRoomMessage(roomId, event);
  });
  client.on("room.encrypted_event", (roomId, event) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: encrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });
  client.on("room.decrypted_event", (roomId, event) => {
    const eventId = event?.event_id ?? "unknown";
    const eventType = event?.type ?? "unknown";
    logVerboseMessage(`matrix: decrypted event room=${roomId} type=${eventType} id=${eventId}`);
  });
  client.on(
    "room.failed_decryption",
    async (roomId, event, error) => {
      logger.warn("Failed to decrypt message", {
        roomId,
        eventId: event.event_id,
        error: error.message
      });
      logVerboseMessage(
        `matrix: failed decrypt room=${roomId} id=${event.event_id ?? "unknown"} error=${error.message}`
      );
    }
  );
  client.on("room.invite", (roomId, event) => {
    const eventId = event?.event_id ?? "unknown";
    const sender = event?.sender ?? "unknown";
    const isDirect = event?.content?.is_direct === true;
    logVerboseMessage(
      `matrix: invite room=${roomId} sender=${sender} direct=${String(isDirect)} id=${eventId}`
    );
  });
  client.on("room.join", (roomId, event) => {
    const eventId = event?.event_id ?? "unknown";
    logVerboseMessage(`matrix: join room=${roomId} id=${eventId}`);
  });
  client.on("room.event", (roomId, event) => {
    const eventType = event?.type ?? "unknown";
    if (eventType === EventType.RoomMessageEncrypted) {
      logVerboseMessage(
        `matrix: encrypted raw event room=${roomId} id=${event?.event_id ?? "unknown"}`
      );
      if (auth.encryption !== true && !warnedEncryptedRooms.has(roomId)) {
        warnedEncryptedRooms.add(roomId);
        const warning = "matrix: encrypted event received without encryption enabled; set channels.matrix.encryption=true and verify the device to decrypt";
        logger.warn(warning, { roomId });
      }
      if (auth.encryption === true && !client.crypto && !warnedCryptoMissingRooms.has(roomId)) {
        warnedCryptoMissingRooms.add(roomId);
        const hint = formatNativeDependencyHint({
          packageName: "@matrix-org/matrix-sdk-crypto-nodejs",
          manager: "pnpm",
          downloadCommand: "node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js"
        });
        const warning = `matrix: encryption enabled but crypto is unavailable; ${hint}`;
        logger.warn(warning, { roomId });
      }
      return;
    }
    if (eventType === EventType.RoomMember) {
      const membership = event?.content?.membership;
      const stateKey = event.state_key ?? "";
      logVerboseMessage(
        `matrix: member event room=${roomId} stateKey=${stateKey} membership=${membership ?? "unknown"}`
      );
    }
  });
}
export {
  registerMatrixMonitorEvents
};
