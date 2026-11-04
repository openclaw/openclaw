import { generateKeyPairSync } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { GatewayIngressPrincipal } from "openclaw/plugin-sdk/gateway-ingress";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { identityFromPrivateKey, RelayError } from "./protocol.js";

export type RelayGrantAuthority = {
  readonly principal: Readonly<GatewayIngressPrincipal>;
  readonly ceiling: readonly string[];
  readonly principalLabel?: string;
};

export type RelayGrant = RelayGrantAuthority & {
  grantId: string;
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt?: number;
};

const OWNER_AUTHORITY: RelayGrantAuthority = {
  principal: { kind: "owner" },
  ceiling: ["operator.read", "operator.write"],
};

function stateError(): RelayError {
  return new RelayError(
    "unavailable",
    "MCP relay state is missing or invalid. Restore a valid OpenClaw state backup before enabling the plugin again.",
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseAuthority(value: Record<string, unknown>): RelayGrantAuthority {
  const { principal, ceiling, principalLabel } = value;
  if (
    !isRecord(principal) ||
    !Array.isArray(ceiling) ||
    !ceiling.every((scope): scope is string => typeof scope === "string" && scope.length > 0) ||
    (principalLabel !== undefined && typeof principalLabel !== "string")
  ) {
    throw stateError();
  }
  let parsedPrincipal: GatewayIngressPrincipal;
  if (principal.kind === "owner") {
    parsedPrincipal = { kind: "owner" };
  } else if (
    principal.kind === "person" &&
    typeof principal.profileId === "string" &&
    principal.profileId.trim()
  ) {
    parsedPrincipal = { kind: "person", profileId: principal.profileId };
  } else {
    throw stateError();
  }
  return {
    principal: parsedPrincipal,
    ceiling: [...ceiling],
    ...(principalLabel === undefined ? {} : { principalLabel }),
  };
}

function parseGrant(value: unknown): RelayGrant {
  if (
    !isRecord(value) ||
    typeof value.grantId !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.clientName !== "string" ||
    !timestamp(value.createdAt) ||
    (value.lastUsedAt !== undefined && !timestamp(value.lastUsedAt))
  ) {
    throw stateError();
  }
  return {
    grantId: value.grantId,
    clientId: value.clientId,
    clientName: value.clientName,
    createdAt: value.createdAt,
    ...parseAuthority(value),
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
  };
}

export class RelayState {
  readonly #store: PluginStateKeyedStore<unknown, 2>;
  readonly #relayOrigin: string;
  readonly #assertCurrent: () => void;
  readonly #grants = new Map<string, RelayGrant>();
  #updates: Promise<void> = Promise.resolve();

  constructor(runtime: Pick<PluginRuntime, "state">, relayUrl: string, assertCurrent: () => void) {
    this.#relayOrigin = new URL(relayUrl).origin;
    this.#assertCurrent = assertCurrent;
    this.#store = runtime.state.openKeyedStoreV2<unknown>(
      { namespace: "mcp-relay-authority", maxEntries: 1_101, overflowPolicy: "reject-new" },
      { assertCurrent },
    );
  }

  async initialize(): Promise<ReturnType<typeof identityFromPrivateKey>> {
    let identity = await this.#store.lookup("identity");
    if (identity === undefined) {
      identity = {
        relayOrigin: this.#relayOrigin,
        privateKey: generateKeyPairSync("ed25519")
          .privateKey.export({ type: "pkcs8", format: "der" })
          .toString("base64url"),
      };
      await this.#store.register("identity", identity);
    }
    if (
      !isRecord(identity) ||
      typeof identity.privateKey !== "string" ||
      typeof identity.relayOrigin !== "string"
    ) {
      throw stateError();
    }
    if (identity.relayOrigin !== this.#relayOrigin) {
      throw new RelayError(
        "unavailable",
        `MCP relay identity is bound to ${identity.relayOrigin}. Restore the matching relayUrl in the plugin configuration.`,
      );
    }
    let resolvedIdentity: ReturnType<typeof identityFromPrivateKey>;
    try {
      resolvedIdentity = identityFromPrivateKey(identity.privateKey);
    } catch {
      throw stateError();
    }
    this.#grants.clear();
    for (const entry of await this.#store.entries()) {
      if (entry.key.startsWith("grant:")) {
        const grant = parseGrant(entry.value);
        this.#grants.set(grant.grantId, grant);
      }
    }
    return resolvedIdentity;
  }

  async #update<T>(action: () => Promise<T>): Promise<T> {
    // Grant writes and revocations share an order so writes cannot restore a deleted row.
    const update = this.#updates.then(action);
    this.#updates = update.then(
      () => {},
      () => {},
    );
    return update;
  }

  assertGrantCurrent(grantId: string): void {
    if (!this.getGrant(grantId)) {
      throw new RelayError(
        "grant_revoked",
        "This connection was revoked. Run openclaw mcp-relay pair and connect again.",
      );
    }
  }

  getGrant(grantId: string): Readonly<RelayGrant> | undefined {
    this.#assertCurrent();
    return this.#grants.get(grantId);
  }

  async issue(
    codeHash: string,
    expiresAt: number,
    now: number,
    assertCommandCurrent?: () => void,
    authority: RelayGrantAuthority = OWNER_AUTHORITY,
  ): Promise<void> {
    await this.#store.register(`code:${codeHash}`, authority, {
      ttlMs: expiresAt - now,
      assertCurrent: assertCommandCurrent,
    });
  }

  async createGrant(
    params: { grantId: string; codeHash: string; client: { id: string; name: string } },
    now: number,
  ): Promise<boolean> {
    return this.#update(async () => {
      // Active IDs keep their authority because principal bindings are cached by grant ID.
      if (this.getGrant(params.grantId)) {
        throw new RelayError("invalid_params", "This grant ID is already connected.");
      }
      const value = await this.#store.consume(`code:${params.codeHash}`);
      if (value === undefined) {
        return false;
      }
      if (!isRecord(value)) {
        throw stateError();
      }
      const code = parseAuthority(value);
      // A crash after consuming a code requires a fresh pairing code, not recovery machinery.
      const grant: RelayGrant = {
        grantId: params.grantId,
        clientId: params.client.id,
        clientName: params.client.name,
        createdAt: now,
        principal: code.principal,
        ceiling: code.ceiling,
        ...(code.principalLabel === undefined ? {} : { principalLabel: code.principalLabel }),
      };
      await this.#store.register(`grant:${grant.grantId}`, grant);
      this.#grants.set(grant.grantId, grant);
      return true;
    });
  }

  async approveGrant(
    grant: Omit<RelayGrant, "lastUsedAt">,
    assertCommandCurrent: () => void,
  ): Promise<void> {
    return this.#update(async () => {
      await this.#store.register(`grant:${grant.grantId}`, grant, {
        assertCurrent: assertCommandCurrent,
      });
      this.#grants.set(grant.grantId, grant);
    });
  }

  async authorize(grantId: string, now: number): Promise<Readonly<RelayGrant> | undefined> {
    return this.#update(async () => {
      const grant = this.getGrant(grantId);
      if (!grant) {
        return undefined;
      }
      const updated = { ...grant, lastUsedAt: now };
      await this.#store.register(`grant:${grantId}`, updated);
      this.#grants.set(grantId, updated);
      return updated;
    });
  }

  async revoke(grantId: string, assertCommandCurrent?: () => void): Promise<boolean> {
    return this.#update(async () => {
      const removed = await this.#store.delete(`grant:${grantId}`, {
        assertCurrent: assertCommandCurrent,
      });
      this.#grants.delete(grantId);
      return removed;
    });
  }

  async grants(): Promise<RelayGrant[]> {
    this.#assertCurrent();
    return [...this.#grants.values()];
  }
}
