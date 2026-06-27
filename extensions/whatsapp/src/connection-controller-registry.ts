// Whatsapp plugin module implements connection controller registry behavior.
import type { WASocket } from "baileys";
import type { WhatsAppSelfIdentity } from "./identity.js";
import type { ActiveWebListener } from "./inbound/types.js";

export type WhatsAppConnectionControllerHandle = {
  getActiveListener(): ActiveWebListener | null;
  getCurrentSock(): WASocket | null;
  /**
   * The self identity (jid + lid) of the controller's currently-authenticated
   * socket, or `null` if the socket is not connected or not authenticated yet.
   * Used as the session-identity guard for outbound socket fallback so an
   * in-place relink to a different phone number is not silently accepted.
   * Compared via `identitiesOverlap()` so JID-vs-LID and device-scoped JID
   * differences between the two controllers' user records are normalized away.
   */
  getSelfIdentity(): WhatsAppSelfIdentity | null;
};

type ConnectionRegistryState = {
  controllers: Map<string, WhatsAppConnectionControllerHandle>;
};

const CONNECTION_REGISTRY_KEY = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");

function getConnectionRegistryState(): ConnectionRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [CONNECTION_REGISTRY_KEY]?: ConnectionRegistryState;
  };
  const existing = globalState[CONNECTION_REGISTRY_KEY];
  if (existing) {
    return existing;
  }
  const created: ConnectionRegistryState = {
    controllers: new Map<string, WhatsAppConnectionControllerHandle>(),
  };
  globalState[CONNECTION_REGISTRY_KEY] = created;
  return created;
}

export function getRegisteredWhatsAppConnectionController(
  accountId: string,
): WhatsAppConnectionControllerHandle | null {
  return getConnectionRegistryState().controllers.get(accountId) ?? null;
}

export function registerWhatsAppConnectionController(
  accountId: string,
  controller: WhatsAppConnectionControllerHandle,
): void {
  getConnectionRegistryState().controllers.set(accountId, controller);
}

export function unregisterWhatsAppConnectionController(
  accountId: string,
  controller: WhatsAppConnectionControllerHandle,
): void {
  const controllers = getConnectionRegistryState().controllers;
  if (controllers.get(accountId) === controller) {
    controllers.delete(accountId);
  }
}
