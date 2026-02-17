// ═══════════════════════════════════════════════════════════════════════════
// The Six Fingered Man — Governance Type Definitions
// ═══════════════════════════════════════════════════════════════════════════
//
// Six layers of isolation: Identity, Ledger, Data, Compute, Network, Sandbox
// Standards: W3C DIDs (did:key, did:web), Verifiable Credentials, ERC-8004
//
// ═══════════════════════════════════════════════════════════════════════════

// ── DID Types ───────────────────────────────────────────────────────────────

/**
 * A W3C Decentralized Identifier.
 *
 * - `did:key:z6Mk...` — derived from Ed25519 public key, no registry needed
 * - `did:web:example.com` — domain-verifiable, resolves via HTTPS
 */
export type DID = `did:key:${string}` | `did:web:${string}`;

/** DID Document verification method (Ed25519). */
export interface VerificationMethod {
  id: string;
  type: "Ed25519VerificationKey2020";
  controller: DID;
  publicKeyMultibase: string;
}

/** W3C DID Document — resolvable identity record. */
export interface DIDDocument {
  "@context": "https://www.w3.org/ns/did/v1";
  id: DID;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
}

// ── Scope & Roles ───────────────────────────────────────────────────────────

/** Authorization scope — hierarchical, non-cascading by default. */
export type Scope =
  | { type: "tenant"; tenantId: string }
  | { type: "project"; projectId: string }
  | { type: "agent"; agentId: string };

/**
 * Roles — simple now, extensible to fine-grained capabilities later.
 *
 * - `owner`      — Full control at scope: CRUD everything, manage grants
 * - `operator`   — Issue commands, approve actions, manage agents
 * - `observer`   — Read-only: dashboards, ledger, meeting transcripts
 * - `escalation` — Receive alerts, respond to escalations, limited commands
 */
export type Role = "owner" | "operator" | "observer" | "escalation";

// ── Permission Grants ───────────────────────────────────────────────────────

/** Conditions that must be met for a grant to authorize an action. */
export interface GrantConditions {
  /** Require the action to come from an enrolled device. */
  requireDeviceCert: boolean;
  /** Require a 2FA challenge (FIDO or TOTP) for this action. */
  require2FA: boolean;
  /** Require phish-resistant MFA (FIDO or keypair). Blocks TOTP-only auth. */
  requirePhishResistant: boolean;
  /** Optional time window restriction (e.g., "09:00-17:00"). */
  allowedHours?: string;
}

/**
 * A permission grant — assigns a role at a scope to a human.
 *
 * Grants do NOT cascade by default. A tenant-scoped grant does not
 * automatically give access to project-scoped agents. Set `cascade: true`
 * explicitly to allow downward inheritance.
 */
export interface PermissionGrant {
  id: string;
  role: Role;
  scope: Scope;
  /** Allow this grant to cascade to child scopes. Default false. */
  cascade: boolean;
  /** DID of the human who issued this grant. */
  grantedBy: DID;
  grantedAt: string;
  /** Optional expiration. Null/undefined = standing grant. */
  expiresAt?: string;
  conditions: GrantConditions;
}

// ── Escalation Chain ────────────────────────────────────────────────────────

/** A single tier in an escalation chain. */
export interface EscalationTier {
  /** Priority order (1 = first contact, 2 = second, etc.). */
  priority: number;
  /** DID of the human to contact at this tier. */
  humanDid: DID;
  /** How long to wait for a response before escalating to the next tier. */
  timeoutSeconds: number;
  /** Channel to use for this tier. Falls back to next available. */
  channel: "signal" | "sms" | "email" | "dashboard";
}

/**
 * An ordered escalation chain scoped to a tenant, project, or agent.
 *
 * When an event requires human intervention (SOC alert, action approval
 * timeout, agent freeze), the system contacts humans in tier order.
 * If no one responds across all tiers, the system triggers a DevSOC
 * freeze — all agents at the scope are suspended until a human intervenes.
 */
export interface EscalationChain {
  id: string;
  scope: Scope;
  tiers: EscalationTier[];
  /** Action on total escalation failure (all tiers exhausted). */
  fallbackAction: "freeze" | "continue" | "notify-only";
  createdBy: DID;
  createdAt: string;
}

// ── Device Enrollment ───────────────────────────────────────────────────────

/** Authentication method type — ordered by strength. */
export type AuthMethod = "fido" | "keypair" | "totp";

/** FIDO/WebAuthn device-specific registration data. */
export interface FIDORegistration {
  credentialId: string;
  publicKey: string;
  attestation?: string;
}

/** TOTP device-specific registration data. */
export interface TOTPRegistration {
  /** Hashed TOTP secret — never store plaintext. */
  secretHash: string;
}

/**
 * An enrolled device bound to a human's identity.
 *
 * Each device has its own Ed25519 keypair (DID) and an authentication
 * method. The device DID is linked to the human's root DID.
 */
export interface DeviceEnrollment {
  id: string;
  /** DID for this device's keypair. */
  did: DID;
  humanId: string;
  name: string;
  type: AuthMethod;
  /** Whether this auth method is phishing-resistant. */
  phishResistant: boolean;
  fido?: FIDORegistration;
  totp?: TOTPRegistration;
  enrolledAt: string;
  /** DID of the human who approved this enrollment. */
  enrolledBy: DID;
  lastUsed?: string;
  status: "active" | "revoked";
}

// ── Human ────────────────────────────────────────────────────────────────────

/** Contact channels for a human. */
export interface HumanContact {
  signal?: string;
  sms?: string;
  email?: string;
}

/**
 * A human participant in the governance system.
 *
 * Humans authenticate via enrolled devices (FIDO preferred, TOTP fallback).
 * Their capabilities are defined by permission grants at specific scopes.
 * A single human can hold multiple grants across tenants and projects.
 *
 * All human actions are recorded on the ledger with full auth context:
 * device used, auth method, location, grant that authorized the action.
 */
export interface Human {
  id: string;
  /** Root identity — did:key from primary Ed25519 keypair. */
  did: DID;
  tenantId: string;
  name: string;
  contact: HumanContact;
  devices: DeviceEnrollment[];
  grants: PermissionGrant[];
  status: "active" | "suspended" | "inactive";
}

// ── Agent ────────────────────────────────────────────────────────────────────

/** Model assignment for an AI agent. */
export interface ModelAssignment {
  provider: string;
  model: string;
  server: string;
}

/**
 * Maturity level per function category.
 *
 * - Level 1: Human-in-the-loop (every action requires approval)
 * - Level 2: Human-on-the-loop (autonomous for routine, humans monitor)
 * - Level 3: Human-on-the-side (independent, humans review summaries)
 * - Level 4: Full autonomy (within permission contracts, periodic reports)
 */
export type MaturityLevel = 1 | 2 | 3 | 4;

/**
 * Function categories for maturity level assignment.
 *
 * An agent can be at different maturity levels for different functions.
 * Example: Level 3 for "research" but Level 1 for "finance".
 */
export type FunctionCategory =
  | "communications"
  | "research"
  | "finance"
  | "content"
  | "code-execution"
  | "infrastructure"
  | "external-api";

/** Agent workspace template references. */
export interface AgentWorkspace {
  identityMd: string;
  soulMd: string;
  agentsMd: string;
}

/**
 * Agent assignment scope.
 *
 * - Tenant-scoped agents (CEO, COO, CFO) operate across the entire tenant.
 * - Project-scoped agents (security, dev, marketing) operate within one project.
 *
 * Scope determines which humans can command this agent: a human needs
 * a grant at the agent's scope (or the agent's specific ID) to interact.
 */
export type AgentAssignment =
  | { scope: "tenant"; tenantId: string }
  | { scope: "project"; projectId: string };

/**
 * An AI agent — an autonomous entity with its own cryptographic identity.
 *
 * Agents have a DID, a model assignment, per-function maturity levels,
 * and a workspace defining their persona. What an agent *does* (its role,
 * its project assignment) is a relationship — the agent itself is just
 * an identity with capabilities.
 */
export interface Agent {
  id: string;
  /** Agent identity — did:key from Ed25519 keypair. */
  did: DID;
  /** Every agent belongs to a tenant, regardless of assignment scope. */
  tenantId: string;
  /** Where this agent operates — tenant-wide or within a specific project. */
  assignment: AgentAssignment;
  name: string;
  role: string;
  model: ModelAssignment;
  maturity: Partial<Record<FunctionCategory, MaturityLevel>>;
  skills: string[];
  workspace: AgentWorkspace;
  status: "active" | "suspended" | "retired";
}

// ── Project ─────────────────────────────────────────────────────────────────

/**
 * A project (workstream, profit center) within a tenant.
 *
 * Projects are the primary unit of agent roster isolation.
 * A tenant-scoped human cannot command a project-scoped agent
 * without an explicit project-level grant.
 */
export interface Project {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  agents: Agent[];
  /** ID of the ledger for this project (own ledger if hard-isolated). */
  ledgerId: string;
  status: "active" | "paused" | "archived";
  createdAt: string;
}

// ── Entity Type ──────────────────────────────────────────────────────────────

/**
 * Business entity type — drives governance defaults, agent templates,
 * maturity starting levels, and onboarding questions.
 *
 * Selecting an entity type at tenant creation scaffolds intelligent defaults
 * for the entire governance configuration.
 */
export type EntityType =
  | "personal"
  | "sole-proprietor"
  | "partnership"
  | "llc"
  | "s-corp"
  | "franchise"
  | "non-profit";

/**
 * Entity-type-specific configuration captured during onboarding.
 *
 * Each entity type has different relevant fields. Only the fields
 * applicable to the entity type will be populated.
 */
export interface EntityConfig {
  /** Number of partners (partnership). */
  partnerCount?: number;
  /** Single-member or multi-member (LLC). */
  memberStructure?: "single" | "multi";
  /** Number of members (LLC multi-member). */
  memberCount?: number;
  /** Franchisor or franchisee (franchise). */
  franchiseRole?: "franchisor" | "franchisee";
  /** Parent tenant ID for franchisees. */
  parentTenantId?: string;
  /** Business category — drives agent roster suggestions. */
  businessCategory?: string;
  /** Multi-sig threshold override (default inferred from entity type). */
  multiSigThreshold?: number;
}

// ── Tenant ──────────────────────────────────────────────────────────────────

/**
 * Tenant isolation type.
 *
 * - `hard` — Separate Postgres schema, own ledger, own encryption keys.
 *           For separate LLCs or customers requiring full isolation.
 * - `soft` — Shared infrastructure, row-level security, tagged ledger entries.
 *           For profit centers under one LLC.
 */
export type TenantIsolation = "hard" | "soft";

/** Default maturity levels applied to new agents in this tenant. */
export type MaturityConfig = Partial<Record<FunctionCategory, MaturityLevel>>;

/**
 * A tenant — the top-level organizational entity.
 *
 * One tenant = one legal entity or customer account.
 * Contains projects, humans, and governance configuration.
 *
 * Agents live at two levels:
 * - `agents` — tenant-scoped agents (CEO, COO, CFO) that operate across
 *   all projects within this tenant.
 * - `projects[].agents` — project-scoped agents that operate within
 *   a single project and are isolated from other projects.
 */
export interface Tenant {
  id: string;
  /** Tenant identity — did:web for domain-verifiable org identity. */
  did: DID;
  name: string;
  /** Business entity type — drives governance defaults. */
  entityType: EntityType;
  /** Entity-type-specific configuration. */
  entityConfig: EntityConfig;
  isolation: TenantIsolation;
  /** Whether multi-sig is required for governance actions. */
  multiSigRequired: boolean;
  /** Multi-sig threshold (e.g., 2 of 3 partners). 0 = no multi-sig. */
  multiSigThreshold: number;
  defaultMaturity: MaturityConfig;
  /** Tenant-scoped agents (CEO, COO, CFO, etc.). */
  agents: Agent[];
  projects: Project[];
  humans: Human[];
  createdAt: string;
  updatedAt: string;
}

// ── Tenant Templates ────────────────────────────────────────────────────────

/** An agent template used during tenant scaffolding. */
export interface AgentTemplate {
  name: string;
  role: string;
  suggestedModel?: string;
  skills: string[];
}

/**
 * A tenant template — the defaults scaffolded from an entity type.
 *
 * When a user selects an entity type during onboarding, the system
 * generates a TenantTemplate with smart defaults. The user can then
 * customize before finalizing.
 */
export interface TenantTemplate {
  entityType: EntityType;
  isolation: TenantIsolation;
  multiSigRequired: boolean;
  multiSigThreshold: number;
  defaultMaturity: MaturityConfig;
  suggestedAgents: AgentTemplate[];
  meetingCadence: string[];
  escalationTiers: number;
}

// ── Auth Context ────────────────────────────────────────────────────────────

/** Geolocation derived from IP (best-effort). */
export interface GeoLocation {
  country: string;
  region?: string;
  city?: string;
}

/**
 * Authentication context recorded with every ledger entry.
 *
 * For human actions: full device, method, location, and grant traceability.
 * For agent actions: minimal (just the agent's key signature).
 */
export interface AuthContext {
  method: AuthMethod | "agent-key";
  /** DID of the enrolled device used. */
  deviceDid?: DID;
  deviceName?: string;
  ip?: string;
  geo?: GeoLocation;
  /** ID of the PermissionGrant that authorized this action. */
  grantUsed?: string;
}

// ── Ledger ──────────────────────────────────────────────────────────────────

/**
 * Ledger entry status in a multi-sig validated ledger.
 *
 * - `pending`   — Signed by one validator, awaiting countersignature.
 * - `confirmed` — Both validators have signed. Canonical.
 * - `disputed`  — One validator challenges the entry.
 */
export type LedgerEntryStatus = "pending" | "confirmed" | "disputed";

/**
 * A single entry in the append-only, tamper-evident ledger.
 *
 * Every significant action — human or agent — produces a ledger entry.
 * Entries form a hash chain (each references the previous entry's hash)
 * and require multi-sig validation in managed service scenarios.
 */
export interface LedgerEntry {
  id: string;
  timestamp: string;
  /** SHA-256 hash of the previous entry (hash chain link). */
  prevHash: string;

  // WHO
  actorDid: DID;
  actorType: "human" | "agent";

  // HOW
  authContext: AuthContext;

  // WHAT
  action: LedgerAction;
  scope: Scope;
  payload: Record<string, unknown>;

  // PROOF
  /** Validator signatures — keyed by validator DID. */
  signatures: Record<string, string>;
  status: LedgerEntryStatus;
}

/**
 * Ledger action categories.
 *
 * Namespaced strings: `domain.verb`
 */
export type LedgerAction =
  // Identity lifecycle
  | "identity.create"
  | "identity.rotate"
  | "identity.revoke"
  // Device management
  | "device.enroll"
  | "device.revoke"
  // Grant management
  | "grant.create"
  | "grant.revoke"
  | "grant.expire"
  // Agent actions
  | "agent.command"
  | "agent.delegate"
  | "agent.message"
  | "agent.complete"
  // Governance
  | "action.approve"
  | "action.reject"
  | "action.escalate"
  | "contract.create"
  | "contract.revoke"
  | "contract.expire"
  // Maturity
  | "maturity.promote"
  | "maturity.demote"
  // SOC
  | "soc.alert"
  | "soc.freeze"
  | "soc.unfreeze"
  // Tenant/project management
  | "tenant.create"
  | "tenant.update"
  | "project.create"
  | "project.update"
  | "project.archive"
  // Meetings
  | "meeting.start"
  | "meeting.end"
  | "meeting.artifact"
  // Auth
  | "auth.challenge"
  | "auth.success"
  | "auth.failure";

// ── Ledger Validation (Multi-Sig) ──────────────────────────────────────────

/** A validator endpoint in the multi-sig consensus. */
export interface LedgerValidator {
  did: DID;
  endpoint: string;
}

/**
 * Ledger validation configuration.
 *
 * - `single` — Single validator (development, self-hosted).
 * - `multi-sig` — 2-of-2 multi-sig between platform and tenant.
 *   50/50 split: both parties must sign. Neither can unilaterally
 *   alter the ledger. Pending entries queue when one party is offline.
 */
export interface LedgerValidation {
  mode: "single" | "multi-sig";
  validators?: {
    platform: LedgerValidator;
    tenant: LedgerValidator;
    /** Number of signatures required. 2 for 50/50 multi-sig. */
    requiredSignatures: number;
    /** Duration before pending entries trigger an alert (ISO 8601 duration). */
    pendingTimeout: string;
  };
}

// ── Permission Contracts (Verifiable Credentials) ───────────────────────────

/**
 * A permission contract — a Verifiable Credential authorizing cross-agent
 * communication or action execution.
 *
 * Every cross-agent interaction requires an active, non-expired,
 * correctly-scoped permission contract.
 */
export interface PermissionContract {
  id: string;
  /** VC type identifiers. */
  types: ["VerifiableCredential", "PermissionContract"];
  /** DID of the issuer (human operator or authorized agent). */
  issuer: DID;
  /** DID of the agent receiving this permission. */
  subject: DID;
  issuedAt: string;
  expiresAt: string;
  /** What this contract authorizes. */
  scope: {
    actions: string[];
    targetAgents: DID[];
    constraints?: Record<string, unknown>;
  };
  /** Ed25519 signature over the contract. */
  proof: {
    type: "Ed25519Signature2020";
    verificationMethod: string;
    proofValue: string;
  };
  status: "active" | "revoked" | "expired";
}

// ── Merkle Tree ─────────────────────────────────────────────────────────────

/** A node in the Merkle tree for tamper-evidence verification. */
export interface MerkleNode {
  hash: string;
  left?: string;
  right?: string;
}

/** Merkle tree root computed over a block of ledger entries. */
export interface MerkleRoot {
  root: string;
  blockStart: number;
  blockEnd: number;
  entryCount: number;
  computedAt: string;
  /** Optional: anchored to public chain for external verifiability. */
  anchor?: {
    chain: string;
    txHash: string;
    blockNumber: number;
    anchoredAt: string;
  };
}
