import { TwitchClientManager } from "./twitch-client.js";
import type { ChannelAccountSnapshot, ChannelLogSink } from "./types.js";

const registry = new Map<string, TwitchClientManager>();

export function getOrCreateClientManager(
  accountId: string,
  logger: ChannelLogSink,
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void,
): TwitchClientManager {
  const existing = registry.get(accountId);
  if (existing) {
    existing.setStatusSink(statusSink);
    return existing;
  }

  const manager = new TwitchClientManager(logger, statusSink);
  registry.set(accountId, manager);
  return manager;
}

export function getClientManager(accountId: string): TwitchClientManager | undefined {
  return registry.get(accountId);
}

export async function removeClientManager(accountId: string): Promise<void> {
  const manager = registry.get(accountId);
  if (!manager) {
    return;
  }

  registry.delete(accountId);
  await manager.disconnectAll();
}
