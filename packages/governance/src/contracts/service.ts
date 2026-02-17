/**
 * Permission Contract Service — CRUD + authorization checking.
 *
 * Permission contracts are W3C Verifiable Credentials that authorize
 * cross-agent communication and action execution. Every cross-agent
 * interaction requires an active, non-expired, correctly-scoped contract.
 *
 * Contracts are:
 * - Ed25519-signed by the issuer (human operator or authorized agent)
 * - Content-addressed (ID = SHA-256 of canonical JSON body)
 * - Time-bound (TTL, auto-expires)
 * - Revocable (issuer or operator can revoke)
 * - Audited (all lifecycle events recorded on the governance ledger)
 *
 * Storage: canonical JSON in ContentStore (contracts/ prefix).
 * Signing: SHA-256(canonical_json) → Ed25519 signature.
 */

import { sha256 } from "@noble/hashes/sha256";
import type { Ledger } from "../ledger/ledger.js";
import type { ContentStore } from "../ledger/store.js";
import type { DID } from "../types.js";
import type { PermissionContract } from "../types.js";
import { signWithDID, verifyWithDID, toHex } from "../identity/did.js";
import { ActorType, ScopeType } from "../ledger/schemas.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Input for creating a new permission contract. */
export interface CreateContractInput {
  /** DID of the issuer (human operator or authorized agent). */
  issuerDid: DID;
  /** Ed25519 private key of the issuer (for signing). */
  issuerPrivateKey: Uint8Array;
  /** DID of the agent receiving the permission. */
  subjectDid: DID;
  /** Actions this contract authorizes (e.g., "agent.message", "agent.*", "*"). */
  actions: string[];
  /** Target agent DIDs. Use "*" for any agent. */
  targetAgents: (DID | "*")[];
  /** Contract duration in milliseconds. */
  durationMs: number;
  /** Actor type for ledger recording. Default: Human. */
  actorType?: ActorType;
  /** Scope type for ledger recording. Default: Tenant. */
  scopeType?: ScopeType;
  /** Scope ID for ledger recording. Default: "default". */
  scopeId?: string;
  /** Additional constraints on the contract. */
  constraints?: Record<string, unknown>;
}

/** Result of a permission check. */
export interface CheckResult {
  /** Whether the action is authorized. */
  allowed: boolean;
  /** ID of the contract that authorized the action (if allowed). */
  contractId?: string;
  /** Reason for denial (if denied). */
  reason?: string;
}

/** Configuration for the PermissionContractService. */
export interface ContractServiceConfig {
  /** Content store for contract persistence. */
  store?: ContentStore;
  /** Ledger for recording contract lifecycle events. */
  ledger?: Ledger;
}

// ── Canonical JSON ──────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization with sorted keys.
 * Required for content-addressed hashing and signature verification.
 */
export function canonicalize(obj: unknown): string {
  if (obj === null) {
    return "null";
  }
  if (obj === undefined) {
    return "null";
  }
  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }
  if (typeof obj === "number" || typeof obj === "boolean") {
    return String(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  if (typeof obj === "object") {
    const record = obj as Record<string, unknown>;
    const sorted = Object.keys(record).toSorted();
    const pairs = sorted
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`);
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(obj);
}

// ── Service ─────────────────────────────────────────────────────────────────

const CONTRACTS_PREFIX = "contracts/";

export class PermissionContractService {
  // In-memory index
  private contracts = new Map<string, PermissionContract>();
  private bySubject = new Map<string, Set<string>>(); // subjectDid → contract IDs

  private store?: ContentStore;
  private ledger?: Ledger;

  constructor(config: ContractServiceConfig = {}) {
    this.store = config.store;
    this.ledger = config.ledger;
  }

  /**
   * Create, sign, and store a new permission contract.
   *
   * Flow:
   * 1. Build contract body (types, issuer, subject, scope, timestamps)
   * 2. Canonical JSON → SHA-256 → content-addressed ID
   * 3. Sign canonical bytes with issuer's Ed25519 key
   * 4. Store in memory + content store
   * 5. Record contract.create on ledger
   */
  async create(input: CreateContractInput): Promise<PermissionContract> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationMs);

    // Build the contract body (everything that gets signed)
    const body: Record<string, unknown> = {
      types: ["VerifiableCredential", "PermissionContract"],
      issuer: input.issuerDid,
      subject: input.subjectDid,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      scope: {
        actions: input.actions,
        targetAgents: input.targetAgents,
        constraints: input.constraints,
      },
    };

    // Canonical JSON → bytes → hash → content-addressed ID
    const canonical = canonicalize(body);
    const bytes = new TextEncoder().encode(canonical);
    const hashBytes = sha256(bytes);
    const id = toHex(hashBytes);

    // Sign the contract body with issuer's key
    const proof = signWithDID(bytes, input.issuerPrivateKey, input.issuerDid);

    const contract: PermissionContract = {
      id,
      types: ["VerifiableCredential", "PermissionContract"],
      issuer: input.issuerDid,
      subject: input.subjectDid,
      issuedAt: body.issuedAt as string,
      expiresAt: body.expiresAt as string,
      scope: {
        actions: input.actions,
        targetAgents: input.targetAgents as DID[],
        constraints: input.constraints,
      },
      proof: {
        type: proof.type,
        verificationMethod: proof.verificationMethod,
        proofValue: proof.proofValue,
      },
      status: "active",
    };

    // Index in memory
    this.indexContract(contract);

    // Persist to content store
    if (this.store) {
      const contractBytes = new TextEncoder().encode(canonicalize(contract));
      const storeHash = sha256(contractBytes);
      await this.store.put(storeHash, contractBytes, CONTRACTS_PREFIX);
    }

    // Record on ledger (Cold tier — governance action)
    if (this.ledger) {
      await this.ledger.append({
        actorDid: input.issuerDid,
        actorType: input.actorType ?? ActorType.Human,
        action: "contract.create",
        scopeType: input.scopeType ?? ScopeType.Tenant,
        scopeId: input.scopeId ?? "default",
        content: bytes,
      });
    }

    return contract;
  }

  /**
   * Check if an action is authorized by any active contract.
   *
   * Searches all contracts where subject = actorDid, then filters:
   * - Not revoked
   * - Not expired (lazy expiration — marks as expired on check)
   * - Action matches (exact, wildcard "*", or prefix glob "agent.*")
   * - Target matches (exact or wildcard "*")
   *
   * Returns first match. Does not verify signatures (trust the index).
   */
  check(params: { actorDid: DID; action: string; targetDid: DID }): CheckResult {
    const subjectContracts = this.bySubject.get(params.actorDid);
    if (!subjectContracts || subjectContracts.size === 0) {
      return { allowed: false, reason: "No contracts found for actor" };
    }

    const now = new Date();

    for (const contractId of subjectContracts) {
      const contract = this.contracts.get(contractId);
      if (!contract) {
        continue;
      }

      // Skip revoked
      if (contract.status === "revoked") {
        continue;
      }

      // Lazy expiration
      if (contract.status === "active" && new Date(contract.expiresAt) <= now) {
        contract.status = "expired";
        continue;
      }

      if (contract.status === "expired") {
        continue;
      }

      // Check action match
      if (!actionMatches(contract.scope.actions, params.action)) {
        continue;
      }

      // Check target match
      if (!targetMatches(contract.scope.targetAgents, params.targetDid)) {
        continue;
      }

      return { allowed: true, contractId: contract.id };
    }

    return { allowed: false, reason: "No matching active contract" };
  }

  /**
   * Revoke a contract by ID.
   *
   * Only active contracts can be revoked.
   * Records contract.revoke on the ledger.
   */
  async revoke(contractId: string, revokerDid: DID): Promise<boolean> {
    const contract = this.contracts.get(contractId);
    if (!contract) {
      return false;
    }
    if (contract.status !== "active") {
      return false;
    }

    contract.status = "revoked";

    // Record on ledger
    if (this.ledger) {
      await this.ledger.append({
        actorDid: revokerDid,
        actorType: ActorType.Human,
        action: "contract.revoke",
        scopeType: ScopeType.Tenant,
        scopeId: "default",
        content: new TextEncoder().encode(canonicalize({ contractId, revokedBy: revokerDid })),
      });
    }

    return true;
  }

  /**
   * Get a contract by ID.
   */
  get(contractId: string): PermissionContract | null {
    return this.contracts.get(contractId) ?? null;
  }

  /**
   * Verify a contract's Ed25519 signature.
   *
   * Rebuilds the canonical JSON body, then verifies the signature
   * against the issuer's public key (derived from their DID).
   */
  verify(contract: PermissionContract): boolean {
    const body: Record<string, unknown> = {
      types: contract.types,
      issuer: contract.issuer,
      subject: contract.subject,
      issuedAt: contract.issuedAt,
      expiresAt: contract.expiresAt,
      scope: contract.scope,
    };

    const canonical = canonicalize(body);
    const bytes = new TextEncoder().encode(canonical);

    const proof = {
      type: contract.proof.type as "Ed25519Signature2020",
      verificationMethod: contract.proof.verificationMethod,
      created: contract.issuedAt,
      proofValue: contract.proof.proofValue,
    };

    return verifyWithDID(bytes, proof, contract.issuer);
  }

  /**
   * Register an existing contract (e.g., loaded from storage).
   * Does not re-sign or re-store — just indexes it in memory.
   */
  register(contract: PermissionContract): void {
    this.indexContract(contract);
  }

  /**
   * List all active contracts for a subject DID.
   * Performs lazy expiration during listing.
   */
  listForSubject(subjectDid: DID): PermissionContract[] {
    const ids = this.bySubject.get(subjectDid);
    if (!ids) {
      return [];
    }

    const now = new Date();
    const results: PermissionContract[] = [];

    for (const id of ids) {
      const contract = this.contracts.get(id);
      if (!contract) {
        continue;
      }

      // Lazy expiration
      if (contract.status === "active" && new Date(contract.expiresAt) <= now) {
        contract.status = "expired";
      }

      if (contract.status === "active") {
        results.push(contract);
      }
    }

    return results;
  }

  /**
   * List all contracts (any status).
   */
  listAll(): PermissionContract[] {
    return Array.from(this.contracts.values());
  }

  /** Number of contracts in the service (any status). */
  get size(): number {
    return this.contracts.size;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private indexContract(contract: PermissionContract): void {
    this.contracts.set(contract.id, contract);
    const subjectSet = this.bySubject.get(contract.subject) ?? new Set<string>();
    subjectSet.add(contract.id);
    this.bySubject.set(contract.subject, subjectSet);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if an action matches any of the authorized patterns.
 *
 * Supports:
 * - Exact match: "agent.message" matches "agent.message"
 * - Wildcard: "*" matches anything
 * - Prefix glob: "agent.*" matches "agent.message", "agent.command", etc.
 */
function actionMatches(patterns: string[], action: string): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") {
      return true;
    }
    if (pattern === action) {
      return true;
    }
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // "agent." (keep the dot)
      if (action.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a target DID matches any of the authorized targets.
 *
 * Supports:
 * - Exact match: specific DID
 * - Wildcard: "*" matches any agent
 */
function targetMatches(targets: DID[], targetDid: DID): boolean {
  for (const t of targets) {
    if ((t as string) === "*") {
      return true;
    }
    if (t === targetDid) {
      return true;
    }
  }
  return false;
}
