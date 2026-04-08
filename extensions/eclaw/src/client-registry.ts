/**
 * Per-account client registry.
 *
 * The gateway registers a client when it starts an account, the outbound
 * path looks it up by accountId, and the gateway removes it on shutdown.
 */

import { EclawClient } from "./client.js";

const clients = new Map<string, EclawClient>();

/** Track the current inbound event per account so outbound can suppress
 *  duplicate delivery for bot-to-bot events (handled inline by the gateway).
 */
const activeEvent = new Map<string, string>();

export function setEclawClient(accountId: string, client: EclawClient): void {
  clients.set(accountId, client);
}

export function clearEclawClient(accountId: string): void {
  clients.delete(accountId);
}

export function getEclawClient(accountId: string): EclawClient | undefined {
  return clients.get(accountId);
}

export function setActiveEclawEvent(accountId: string, event: string): void {
  activeEvent.set(accountId, event);
}

export function clearActiveEclawEvent(accountId: string): void {
  activeEvent.delete(accountId);
}

export function getActiveEclawEvent(accountId: string): string {
  return activeEvent.get(accountId) ?? "message";
}
