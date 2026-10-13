// Persistent provisioning store on the plugin-state keyed store
// (shared plugin_state_entries SQLite table — no schema bump).
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ProvisioningState } from "./provisioning-states.js";

export type ProvisioningRecord = {
  version: 1;
  installationId: string;
  telegramUserId: string;
  state: ProvisioningState;
  botUsername?: string;
  botId?: string;
  serverId?: number;
  serverIp?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  history: Array<{ state: ProvisioningState; at: string; error?: string }>;
};

export function decodeProvisioningRecord(value: unknown): ProvisioningRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    v["version"] !== 1 ||
    typeof v["installationId"] !== "string" ||
    typeof v["telegramUserId"] !== "string" ||
    typeof v["state"] !== "string" ||
    typeof v["createdAt"] !== "string" ||
    typeof v["updatedAt"] !== "string" ||
    !Array.isArray(v["history"])
  ) {
    return undefined;
  }
  return v as unknown as ProvisioningRecord;
}

export class ProvisioningStore {
  readonly #tailByuser = new Map<string, Promise<void>>();

  constructor(private readonly store: PluginStateKeyedStore<ProvisioningRecord>) {}

  #key(telegramUserId: string): string {
    return `install:${telegramUserId}`;
  }

  #enqueue(telegramUserId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.#tailByuser.get(telegramUserId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.#tailByuser.set(
      telegramUserId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async load(telegramUserId: string): Promise<ProvisioningRecord | undefined> {
    return decodeProvisioningRecord(await this.store.lookup(this.#key(telegramUserId)));
  }

  async save(record: ProvisioningRecord): Promise<void> {
    await this.#enqueue(record.telegramUserId, () =>
      this.store.register(this.#key(record.telegramUserId), record),
    );
  }

  async update(
    telegramUserId: string,
    mutate: (current: ProvisioningRecord | undefined) => ProvisioningRecord,
  ): Promise<ProvisioningRecord> {
    let result: ProvisioningRecord | undefined;
    await this.#enqueue(telegramUserId, async () => {
      const current = decodeProvisioningRecord(await this.store.lookup(this.#key(telegramUserId)));
      result = mutate(current);
      result.updatedAt = new Date().toISOString();
      await this.store.register(this.#key(telegramUserId), result);
    });
    if (!result) {
      throw new Error("ProvisioningStore.update failed");
    }
    return result;
  }

  async listActive(): Promise<ProvisioningRecord[]> {
    const entries = await this.store.entries?.();
    if (!entries) {
      return [];
    }
    return entries
      .map((e) => decodeProvisioningRecord(e.value))
      .filter(
        (r): r is ProvisioningRecord => Boolean(r) && r.state !== "READY" && r.state !== "FAILED",
      );
  }
}
