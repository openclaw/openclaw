import { generateKeyPairSync } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { identityFromPrivateKey, RelayError } from "./protocol.js";

type IssuedGrant = {
  grantId: string;
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

export type RelayGrant = IssuedGrant | { grantId: string; revokedAt: number; lastUsedAt?: never };

type PairingCode = { codeHash: string; expiresAt: number; consumed: boolean };
type RelayRecord = {
  version: 1;
  relayOrigin: string;
  privateKey: string;
  codes: PairingCode[];
  grants: RelayGrant[];
};

const RECORD_KEY = "authority";
const MAX_CODES = 100;
const MAX_GRANTS = 1_000;
const MAX_BYTES = 512 * 1024;

function stateError(): RelayError {
  return new RelayError(
    "unavailable",
    "MCP relay state is missing or invalid. Restore a valid OpenClaw state backup before enabling the plugin again.",
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCode(value: unknown): PairingCode {
  if (
    !isRecord(value) ||
    typeof value.codeHash !== "string" ||
    !timestamp(value.expiresAt) ||
    typeof value.consumed !== "boolean"
  ) {
    throw stateError();
  }
  return { codeHash: value.codeHash, expiresAt: value.expiresAt, consumed: value.consumed };
}

function parseGrant(value: unknown): RelayGrant {
  if (!isRecord(value) || typeof value.grantId !== "string") {
    throw stateError();
  }
  if (Object.keys(value).every((key) => key === "grantId" || key === "revokedAt")) {
    if (!timestamp(value.revokedAt)) {
      throw stateError();
    }
    return { grantId: value.grantId, revokedAt: value.revokedAt };
  }
  if (
    typeof value.clientId !== "string" ||
    typeof value.clientName !== "string" ||
    !timestamp(value.createdAt) ||
    (value.lastUsedAt !== undefined && !timestamp(value.lastUsedAt)) ||
    (value.revokedAt !== undefined && !timestamp(value.revokedAt))
  ) {
    throw stateError();
  }
  return {
    grantId: value.grantId,
    clientId: value.clientId,
    clientName: value.clientName,
    createdAt: value.createdAt,
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  };
}

function parseRecord(value: unknown): RelayRecord {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.relayOrigin !== "string" ||
    typeof value.privateKey !== "string" ||
    !Array.isArray(value.codes) ||
    !Array.isArray(value.grants)
  ) {
    throw stateError();
  }
  const record: RelayRecord = {
    version: 1,
    relayOrigin: value.relayOrigin,
    privateKey: value.privateKey,
    codes: value.codes.map(parseCode),
    grants: value.grants.map(parseGrant),
  };
  if (
    new Set(record.codes.map((code) => code.codeHash)).size !== record.codes.length ||
    new Set(record.grants.map((grant) => grant.grantId)).size !== record.grants.length
  ) {
    throw stateError();
  }
  return record;
}

function assertCapacity(record: RelayRecord): void {
  // Reserve every grant's future timestamps so a full store can still revoke.
  const reserved = {
    ...record,
    grants: record.grants.map((grant) =>
      "createdAt" in grant
        ? {
            ...grant,
            lastUsedAt: Number.MAX_SAFE_INTEGER,
            revokedAt: Number.MAX_SAFE_INTEGER,
          }
        : grant,
    ),
  };
  if (
    record.codes.length > MAX_CODES ||
    record.grants.length > MAX_GRANTS ||
    Buffer.byteLength(JSON.stringify(reserved), "utf8") > MAX_BYTES
  ) {
    throw new RelayError(
      "unavailable",
      "MCP relay state capacity is reached. Wait for unused pairing codes to expire; if pairing still fails, contact your OpenClaw administrator.",
    );
  }
}

export class RelayState {
  readonly #store: PluginStateKeyedStore<unknown>;
  readonly #relayOrigin: string;
  readonly #assertCurrent: () => void;
  readonly #now: () => number;

  constructor(
    runtime: Pick<PluginRuntime, "state">,
    relayUrl: string,
    assertCurrent: () => void,
    now: () => number = Date.now,
  ) {
    this.#relayOrigin = new URL(relayUrl).origin;
    this.#assertCurrent = assertCurrent;
    this.#now = now;
    this.#store = runtime.state.openKeyedStore<unknown>({
      namespace: "mcp-relay-authority",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
  }

  #currentStore(assertOperationCurrent?: () => void): PluginStateKeyedStore<unknown, 2> {
    if (!this.#store.withCurrent) {
      throw new RelayError(
        "unavailable",
        "MCP relay requires current plugin-state authority support. Update OpenClaw and restart the Gateway.",
      );
    }
    return this.#store.withCurrent({
      assertCurrent: () => {
        this.#assertCurrent();
        assertOperationCurrent?.();
      },
    });
  }

  #record(value: unknown): RelayRecord {
    const record = parseRecord(value);
    if (record.relayOrigin !== this.#relayOrigin) {
      throw new RelayError(
        "unavailable",
        `MCP relay identity is bound to ${record.relayOrigin}. Restore the matching relayUrl in the plugin configuration.`,
      );
    }
    return record;
  }

  async initialize(): Promise<{ privateKey: string }> {
    const store = this.#currentStore();
    let observation = await store.observe(RECORD_KEY);
    let candidate: RelayRecord | undefined;
    for (;;) {
      if (observation.value !== undefined) {
        const record = this.#record(observation.value);
        try {
          identityFromPrivateKey(record.privateKey);
        } catch {
          throw stateError();
        }
        return { privateKey: record.privateKey };
      }
      candidate ??= {
        version: 1,
        relayOrigin: this.#relayOrigin,
        privateKey: generateKeyPairSync("ed25519")
          .privateKey.export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
        codes: [],
        grants: [],
      };
      const result = await store.compareAndApply(RECORD_KEY, observation.comparison, {
        operation: "update",
        action: "set",
        value: candidate,
      });
      if (result.status !== "conflict") {
        return { privateKey: candidate.privateKey };
      }
      observation = result.current;
    }
  }

  async #update<T>(
    decide: (record: RelayRecord) => { value?: RelayRecord; result: T },
    assertOperationCurrent?: () => void,
  ): Promise<T> {
    const store = this.#currentStore(assertOperationCurrent);
    let observation = await store.observe(RECORD_KEY);
    for (;;) {
      const decision = decide(this.#record(observation.value));
      const result = await store.compareAndApply(
        RECORD_KEY,
        observation.comparison,
        decision.value
          ? { operation: "update", action: "set", value: decision.value }
          : { operation: "update", action: "keep" },
      );
      if (result.status !== "conflict") {
        return decision.result;
      }
      observation = result.current;
    }
  }

  async issue(
    codeHash: string,
    expiresAt: number,
    now: number,
    assertCommandCurrent?: () => void,
  ): Promise<void> {
    await this.#update((record) => {
      const codes = record.codes.filter((code) => code.expiresAt > now);
      if (codes.some((code) => code.codeHash === codeHash)) {
        throw new RelayError(
          "unavailable",
          "Pairing code already issued. Run openclaw mcp-relay pair again.",
        );
      }
      const value = { ...record, codes: [...codes, { codeHash, expiresAt, consumed: false }] };
      assertCapacity(value);
      return { value, result: undefined };
    }, assertCommandCurrent);
  }

  async createGrant(
    params: { grantId: string; codeHash: string; client: { id: string; name: string } },
    now: number,
  ): Promise<boolean> {
    let selectedExpiresAt: number | undefined;
    return this.#update(
      (record) => {
        const code = record.codes.find((entry) => entry.codeHash === params.codeHash);
        if (
          !code ||
          code.consumed ||
          code.expiresAt <= Math.max(now, this.#now()) ||
          record.grants.some((grant) => grant.grantId === params.grantId)
        ) {
          selectedExpiresAt = undefined;
          return { result: false };
        }
        selectedExpiresAt = code.expiresAt;
        const value: RelayRecord = {
          ...record,
          codes: record.codes.map((entry) =>
            entry === code ? { ...entry, consumed: true } : entry,
          ),
          grants: [
            ...record.grants,
            {
              grantId: params.grantId,
              clientId: params.client.id,
              clientName: params.client.name,
              createdAt: now,
            },
          ],
        };
        assertCapacity(value);
        return { value, result: true };
      },
      () => {
        if (selectedExpiresAt !== undefined && selectedExpiresAt <= this.#now()) {
          throw new RelayError(
            "not_found",
            "That pairing code expired before the grant was saved. Run openclaw mcp-relay pair again.",
          );
        }
      },
    );
  }

  async authorize(grantId: string, now: number): Promise<boolean> {
    return this.#update((record) => {
      const grant = record.grants.find((entry) => entry.grantId === grantId);
      if (!grant || !("createdAt" in grant) || grant.revokedAt !== undefined) {
        return { result: false };
      }
      const usedGrant: IssuedGrant = { ...grant, lastUsedAt: now };
      return {
        value: {
          ...record,
          grants: record.grants.map((entry) => (entry === grant ? usedGrant : entry)),
        },
        result: true,
      };
    });
  }

  async revoke(grantId: string, now: number, assertCommandCurrent?: () => void): Promise<boolean> {
    return this.#revoke(grantId, now, false, assertCommandCurrent);
  }

  async recordRevocation(grantId: string, now: number): Promise<void> {
    await this.#revoke(grantId, now, true);
  }

  async #revoke(
    grantId: string,
    now: number,
    recordUnknown: boolean,
    assertCommandCurrent?: () => void,
  ): Promise<boolean> {
    return this.#update((record) => {
      const grant = record.grants.find((entry) => entry.grantId === grantId);
      if (!grant) {
        if (!recordUnknown) {
          return { result: false };
        }
        const value = {
          ...record,
          grants: [...record.grants, { grantId, revokedAt: now }],
        };
        assertCapacity(value);
        return { value, result: true };
      }
      if (grant.revokedAt !== undefined) {
        return { result: true };
      }
      return {
        value: {
          ...record,
          grants: record.grants.map((entry) =>
            entry === grant ? { ...entry, revokedAt: now } : entry,
          ),
        },
        result: true,
      };
    }, assertCommandCurrent);
  }

  async grants(): Promise<RelayGrant[]> {
    return this.#record(await this.#currentStore().lookup(RECORD_KEY)).grants;
  }
}
