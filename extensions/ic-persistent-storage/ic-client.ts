/// @dfinity/agent wrapper for IC Memory Vault.
/// Handles authentication (II 2.0), agent creation, and canister calls.

import { Actor, HttpAgent } from "@dfinity/agent";
import { AuthClient } from "@dfinity/auth-client";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { IcStorageConfig } from "./config.js";

// -- Candid IDL definitions for our canisters --

// Shared types
const AuditAction = IDL.Variant({
  store: IDL.Null,
  delete: IDL.Null,
  bulkSync: IDL.Null,
  restore: IDL.Null,
  created: IDL.Null,
  accessDenied: IDL.Null,
});

const AuditEntry = IDL.Record({
  timestamp: IDL.Int,
  action: AuditAction,
  caller: IDL.Principal,
  key: IDL.Opt(IDL.Text),
  category: IDL.Opt(IDL.Text),
  details: IDL.Opt(IDL.Text),
});

const MemoryEntry = IDL.Record({
  key: IDL.Text,
  category: IDL.Text,
  content: IDL.Vec(IDL.Nat8),
  metadata: IDL.Text,
  createdAt: IDL.Int,
  updatedAt: IDL.Int,
});

const SessionEntry = IDL.Record({
  sessionId: IDL.Text,
  data: IDL.Vec(IDL.Nat8),
  startedAt: IDL.Int,
  endedAt: IDL.Int,
});

const VaultStats = IDL.Record({
  totalMemories: IDL.Nat,
  totalSessions: IDL.Nat,
  categories: IDL.Vec(IDL.Text),
  bytesUsed: IDL.Nat,
  cycleBalance: IDL.Nat,
  lastUpdated: IDL.Int,
});

const DashboardData = IDL.Record({
  stats: VaultStats,
  recentMemories: IDL.Vec(MemoryEntry),
  recentSessions: IDL.Vec(SessionEntry),
});

const SyncManifest = IDL.Record({
  lastUpdated: IDL.Int,
  memoriesCount: IDL.Nat,
  sessionsCount: IDL.Nat,
  categoryChecksums: IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text)),
});

const SyncResult = IDL.Record({
  stored: IDL.Nat,
  skipped: IDL.Nat,
  errors: IDL.Vec(IDL.Text),
});

const VaultError = IDL.Variant({
  unauthorized: IDL.Null,
  notFound: IDL.Null,
  invalidInput: IDL.Text,
});

const FactoryError = IDL.Variant({
  alreadyExists: IDL.Null,
  insufficientCycles: IDL.Null,
  unauthorized: IDL.Text,
  notFound: IDL.Text,
  creationFailed: IDL.Text,
});

const MemoryInput = IDL.Record({
  key: IDL.Text,
  category: IDL.Text,
  content: IDL.Vec(IDL.Nat8),
  metadata: IDL.Text,
  createdAt: IDL.Int,
  updatedAt: IDL.Int,
});

const SessionInput = IDL.Record({
  sessionId: IDL.Text,
  data: IDL.Vec(IDL.Nat8),
  startedAt: IDL.Int,
  endedAt: IDL.Int,
});

// Result types
const ResultOkUnit = IDL.Variant({ ok: IDL.Null, err: VaultError });
const ResultOkSyncResult = IDL.Variant({ ok: SyncResult, err: VaultError });
const ResultOkPrincipal = IDL.Variant({
  ok: IDL.Principal,
  err: FactoryError,
});

// -- IDL factories --

const userVaultIdlFactory = ({ IDL: _IDL }: { IDL: typeof IDL }) => {
  return IDL.Service({
    store: IDL.Func([IDL.Text, IDL.Text, IDL.Vec(IDL.Nat8), IDL.Text], [ResultOkUnit], []),
    delete: IDL.Func([IDL.Text], [ResultOkUnit], []),
    bulkSync: IDL.Func([IDL.Vec(MemoryInput), IDL.Vec(SessionInput)], [ResultOkSyncResult], []),
    storeSession: IDL.Func([IDL.Text, IDL.Vec(IDL.Nat8), IDL.Int, IDL.Int], [ResultOkUnit], []),
    recall: IDL.Func([IDL.Text], [IDL.Opt(MemoryEntry)], ["query"]),
    getStats: IDL.Func([], [VaultStats], ["query"]),
    getCategories: IDL.Func([], [IDL.Vec(IDL.Text)], ["query"]),
    getAuditLog: IDL.Func([IDL.Nat, IDL.Nat], [IDL.Vec(AuditEntry)], ["query"]),
    getAuditLogSize: IDL.Func([], [IDL.Nat], ["query"]),
    getOwner: IDL.Func([], [IDL.Principal], ["query"]),
    getDashboard: IDL.Func([], [DashboardData], ["composite_query"]),
    recallRelevant: IDL.Func(
      [IDL.Opt(IDL.Text), IDL.Opt(IDL.Text), IDL.Nat],
      [IDL.Vec(MemoryEntry)],
      ["composite_query"],
    ),
    getSyncManifest: IDL.Func([], [SyncManifest], ["composite_query"]),
  });
};

const factoryIdlFactory = ({ IDL: _IDL }: { IDL: typeof IDL }) => {
  return IDL.Service({
    createVault: IDL.Func([], [ResultOkPrincipal], []),
    getVault: IDL.Func([], [IDL.Opt(IDL.Principal)], ["query"]),
    getTotalCreated: IDL.Func([], [IDL.Nat], ["query"]),
    getAllVaults: IDL.Func([], [IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Principal))], ["query"]),
  });
};

// -- TypeScript types matching Candid --

export interface MemoryEntryData {
  key: string;
  category: string;
  content: Uint8Array;
  metadata: string;
  createdAt: bigint;
  updatedAt: bigint;
}

export interface SessionEntryData {
  sessionId: string;
  data: Uint8Array;
  startedAt: bigint;
  endedAt: bigint;
}

export interface VaultStatsData {
  totalMemories: bigint;
  totalSessions: bigint;
  categories: string[];
  bytesUsed: bigint;
  cycleBalance: bigint;
  lastUpdated: bigint;
}

export interface DashboardDataResult {
  stats: VaultStatsData;
  recentMemories: MemoryEntryData[];
  recentSessions: SessionEntryData[];
}

export interface SyncManifestData {
  lastUpdated: bigint;
  memoriesCount: bigint;
  sessionsCount: bigint;
  categoryChecksums: [string, string][];
}

export interface SyncResultData {
  stored: bigint;
  skipped: bigint;
  errors: string[];
}

export interface AuditEntryData {
  timestamp: bigint;
  action:
    | { store: null }
    | { delete: null }
    | { bulkSync: null }
    | { restore: null }
    | { created: null }
    | { accessDenied: null };
  caller: Principal;
  key: [] | [string];
  category: [] | [string];
  details: [] | [string];
}

// -- IC Client --

export class IcClient {
  private agent: HttpAgent | null = null;
  private authClient: AuthClient | null = null;
  private config: IcStorageConfig;

  constructor(config: IcStorageConfig) {
    this.config = config;
  }

  /// Get the IC host URL based on network config.
  private getHost(): string {
    return this.config.network === "local" ? "http://127.0.0.1:4943" : "https://icp0.io";
  }

  /// Initialize the HTTP agent (unauthenticated for queries).
  async initAgent(): Promise<HttpAgent> {
    if (this.agent) return this.agent;

    this.agent = await HttpAgent.create({
      host: this.getHost(),
    });

    // Fetch root key for local dev (required by PocketIC)
    if (this.config.network === "local") {
      await this.agent.fetchRootKey();
    }

    return this.agent;
  }

  /// Initialize authenticated agent via Internet Identity.
  async initAuthenticatedAgent(): Promise<HttpAgent> {
    this.authClient = await AuthClient.create();

    const isAuthenticated = await this.authClient.isAuthenticated();
    if (!isAuthenticated) {
      throw new Error(
        "Not authenticated. Please run /vault-setup to authenticate with Internet Identity.",
      );
    }

    const identity = this.authClient.getIdentity();
    this.agent = await HttpAgent.create({
      host: this.getHost(),
      identity,
    });

    if (this.config.network === "local") {
      await this.agent.fetchRootKey();
    }

    return this.agent;
  }

  /// Authenticate with Internet Identity 2.0.
  /// Returns the principal after successful auth.
  async authenticate(): Promise<Principal> {
    this.authClient = await AuthClient.create();

    return new Promise((resolve, reject) => {
      this.authClient!.login({
        identityProvider:
          this.config.network === "local"
            ? `http://127.0.0.1:4943?canisterId=rdmx6-jaaaa-aaaaa-aaadq-cai`
            : "https://identity.ic0.app",
        onSuccess: async () => {
          const identity = this.authClient!.getIdentity();
          const principal = identity.getPrincipal();

          this.agent = await HttpAgent.create({
            host: this.getHost(),
            identity,
          });

          if (this.config.network === "local") {
            await this.agent.fetchRootKey();
          }

          resolve(principal);
        },
        onError: (error) => {
          reject(new Error(`Authentication failed: ${error}`));
        },
      });
    });
  }

  /// Check if user is currently authenticated.
  async isAuthenticated(): Promise<boolean> {
    if (!this.authClient) {
      this.authClient = await AuthClient.create();
    }
    return this.authClient.isAuthenticated();
  }

  // -- Factory methods --

  /// Create a vault for the current user.
  async createVault(): Promise<{ ok: Principal } | { err: string }> {
    const agent = await this.getAuthenticatedAgent();
    if (!this.config.factoryCanisterId) {
      return { err: "Factory canister ID not configured" };
    }

    const factory = Actor.createActor(factoryIdlFactory, {
      agent,
      canisterId: this.config.factoryCanisterId,
    });

    const result = (await factory.createVault()) as
      | { ok: Principal }
      | {
          err: { alreadyExists: null } | { insufficientCycles: null } | { creationFailed: string };
        };

    if ("ok" in result) {
      return { ok: result.ok };
    }

    const errVal = result.err;
    if ("alreadyExists" in errVal) return { err: "You already have a vault" };
    if ("insufficientCycles" in errVal) return { err: "Factory has insufficient cycles" };
    if ("creationFailed" in errVal)
      return { err: `Vault creation failed: ${errVal.creationFailed}` };
    return { err: "Unknown error" };
  }

  /// Look up the caller's vault.
  async getVault(): Promise<Principal | null> {
    const agent = await this.getAuthenticatedAgent();
    if (!this.config.factoryCanisterId) return null;

    const factory = Actor.createActor(factoryIdlFactory, {
      agent,
      canisterId: this.config.factoryCanisterId,
    });

    const result = (await factory.getVault()) as [] | [Principal];
    return result.length > 0 ? result[0] : null;
  }

  // -- Vault methods --

  /// Store a memory entry.
  async store(
    key: string,
    category: string,
    content: Uint8Array,
    metadata: string,
  ): Promise<{ ok: null } | { err: string }> {
    const actor = await this.getVaultActor();
    const result = (await actor.store(key, category, content, metadata)) as
      | { ok: null }
      | { err: { unauthorized: null } | { invalidInput: string } };

    if ("ok" in result) return { ok: null };
    return { err: this.formatVaultError(result.err) };
  }

  /// Recall a specific memory.
  async recall(key: string): Promise<MemoryEntryData | null> {
    const actor = await this.getVaultActor();
    const result = (await actor.recall(key)) as [] | [MemoryEntryData];
    return result.length > 0 ? result[0] : null;
  }

  /// Delete a memory.
  async delete(key: string): Promise<{ ok: null } | { err: string }> {
    const actor = await this.getVaultActor();
    const result = (await actor.delete(key)) as
      | { ok: null }
      | { err: { unauthorized: null } | { notFound: null } };

    if ("ok" in result) return { ok: null };
    return { err: this.formatVaultError(result.err) };
  }

  /// Bulk sync memories and sessions.
  async bulkSync(
    memories: Array<{
      key: string;
      category: string;
      content: Uint8Array;
      metadata: string;
      createdAt: bigint;
      updatedAt: bigint;
    }>,
    sessions: Array<{
      sessionId: string;
      data: Uint8Array;
      startedAt: bigint;
      endedAt: bigint;
    }>,
  ): Promise<{ ok: SyncResultData } | { err: string }> {
    const actor = await this.getVaultActor();
    const result = (await actor.bulkSync(memories, sessions)) as
      | { ok: SyncResultData }
      | { err: { unauthorized: null } };

    if ("ok" in result) return { ok: result.ok };
    return { err: this.formatVaultError(result.err) };
  }

  /// Store a session.
  async storeSession(
    sessionId: string,
    data: Uint8Array,
    startedAt: bigint,
    endedAt: bigint,
  ): Promise<{ ok: null } | { err: string }> {
    const actor = await this.getVaultActor();
    const result = (await actor.storeSession(sessionId, data, startedAt, endedAt)) as
      | { ok: null }
      | { err: { unauthorized: null } | { invalidInput: string } };

    if ("ok" in result) return { ok: null };
    return { err: this.formatVaultError(result.err) };
  }

  /// Get vault stats.
  async getStats(): Promise<VaultStatsData> {
    const actor = await this.getVaultActor();
    return (await actor.getStats()) as VaultStatsData;
  }

  /// Get dashboard data (composite query).
  async getDashboard(): Promise<DashboardDataResult> {
    const actor = await this.getVaultActor();
    return (await actor.getDashboard()) as DashboardDataResult;
  }

  /// Get sync manifest (composite query).
  async getSyncManifest(): Promise<SyncManifestData> {
    const actor = await this.getVaultActor();
    return (await actor.getSyncManifest()) as SyncManifestData;
  }

  /// Search memories by category/prefix (composite query).
  async recallRelevant(
    category: string | null,
    prefix: string | null,
    limit: number,
  ): Promise<MemoryEntryData[]> {
    const actor = await this.getVaultActor();
    return (await actor.recallRelevant(
      category ? [category] : [],
      prefix ? [prefix] : [],
      BigInt(limit),
    )) as MemoryEntryData[];
  }

  /// Get audit log (paginated).
  async getAuditLog(offset: number, limit: number): Promise<AuditEntryData[]> {
    const actor = await this.getVaultActor();
    return (await actor.getAuditLog(BigInt(offset), BigInt(limit))) as AuditEntryData[];
  }

  /// Get audit log size.
  async getAuditLogSize(): Promise<bigint> {
    const actor = await this.getVaultActor();
    return (await actor.getAuditLogSize()) as bigint;
  }

  /// Get categories.
  async getCategories(): Promise<string[]> {
    const actor = await this.getVaultActor();
    return (await actor.getCategories()) as string[];
  }

  // -- Internal helpers --

  private async getAuthenticatedAgent(): Promise<HttpAgent> {
    if (this.agent) return this.agent;
    return this.initAuthenticatedAgent();
  }

  private async getVaultActor(): Promise<ReturnType<typeof Actor.createActor>> {
    if (!this.config.canisterId) {
      throw new Error("Vault canister ID not configured. Run /vault-setup first.");
    }

    const agent = await this.getAuthenticatedAgent();
    return Actor.createActor(userVaultIdlFactory, {
      agent,
      canisterId: this.config.canisterId,
    });
  }

  private formatVaultError(
    err: { unauthorized: null } | { notFound: null } | { invalidInput: string },
  ): string {
    if ("unauthorized" in err) return "Unauthorized: you are not the vault owner";
    if ("notFound" in err) return "Not found";
    if ("invalidInput" in err) return `Invalid input: ${err.invalidInput}`;
    return "Unknown error";
  }
}
