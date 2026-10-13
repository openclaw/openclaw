// Per-user onboarding session tracking (OP-167, Phase 2).
// Thin wrapper over ProvisioningStore: one record per Telegram user id,
// persisted in the shared plugin_state_entries SQLite table (no schema bump).
// State transitions stay owned by provisioning-states.ts via the orchestrator.

import type { ProvisioningState } from "./provisioning-states.js";
import type { ProvisioningRecord, ProvisioningStore } from "./provisioning-store.js";

export type UserSessionSnapshot = {
  telegramUserId: string;
  state: ProvisioningState;
  botUsername?: string;
  updatedAt: string;
};

export class UserSessionTracker {
  constructor(private readonly store: ProvisioningStore) {}

  async get(telegramUserId: string): Promise<UserSessionSnapshot | undefined> {
    const record = await this.store.load(telegramUserId);
    return record ? toSnapshot(record) : undefined;
  }

  /** True while a run is in a non-terminal state. */
  async isActive(telegramUserId: string): Promise<boolean> {
    const record = await this.store.load(telegramUserId);
    if (!record) {
      return false;
    }
    return record.state !== "READY" && record.state !== "FAILED";
  }

  async touch(telegramUserId: string): Promise<void> {
    await this.store.update(telegramUserId, (current) => {
      if (!current) {
        throw new Error("No provisioning found. Send /install first.");
      }
      return current;
    });
  }
}

function toSnapshot(record: ProvisioningRecord): UserSessionSnapshot {
  return {
    telegramUserId: record.telegramUserId,
    state: record.state,
    botUsername: record.botUsername,
    updatedAt: record.updatedAt,
  };
}
