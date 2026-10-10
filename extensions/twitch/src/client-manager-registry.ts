import { TwitchClientManager } from "./twitch-client.js";
import type { ChannelAccountSnapshot, ChannelLogSink } from "./types.js";

type RegistryEntry = {
  manager: TwitchClientManager;
  logger: ChannelLogSink;
};

const registry = new Map<string, RegistryEntry>();

export function getOrCreateClientManager(
  accountId: string,
  logger: ChannelLogSink,
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void,
): TwitchClientManager {
  const existing = registry.get(accountId);
  if (existing) {
    existing.manager.setStatusSink(statusSink);
    return existing.manager;
  }

  const manager = new TwitchClientManager(logger, statusSink);
  registry.set(accountId, { manager, logger });

  logger.info(`Registered client manager for account: ${accountId}`);
  return manager;
}

export function getClientManager(accountId: string): TwitchClientManager | undefined {
  return registry.get(accountId)?.manager;
}

export async function removeClientManager(accountId: string): Promise<void> {
  const entry = registry.get(accountId);
  if (!entry) {
    return;
  }

  registry.delete(accountId);
  try {
    await entry.manager.disconnectAll();
  } finally {
    entry.logger.info(`Unregistered client manager for account: ${accountId}`);
  }
}
