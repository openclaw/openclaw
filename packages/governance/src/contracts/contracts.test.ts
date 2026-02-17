import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LedgerEventRecord } from "../ledger/schemas.js";
import type { DID, PermissionContract } from "../types.js";
import { generateDID } from "../identity/did.js";
import { Ledger } from "../ledger/ledger.js";
import { InMemoryContentStore } from "../ledger/store.js";
import { PermissionContractService, canonicalize } from "./service.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createService(opts?: { withLedger?: boolean }) {
  const store = new InMemoryContentStore();
  let ledger: Ledger | undefined;
  const events: LedgerEventRecord[] = [];

  if (opts?.withLedger) {
    const ledgerStore = new InMemoryContentStore();
    ledger = new Ledger({
      store: ledgerStore,
      flushThreshold: 1000, // don't auto-flush during tests
      onEvent: (e) => events.push(e),
    });
  }

  const service = new PermissionContractService({ store, ledger });
  return { service, store, ledger, events };
}

// ── Canonical JSON ──────────────────────────────────────────────────────────

describe("Canonical JSON", () => {
  it("sorts object keys deterministically", () => {
    const a = canonicalize({ z: 1, a: 2, m: 3 });
    const b = canonicalize({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects", () => {
    const result = canonicalize({ b: { d: 1, c: 2 }, a: 3 });
    expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("handles arrays (preserves order)", () => {
    const result = canonicalize({ items: [3, 1, 2] });
    expect(result).toBe('{"items":[3,1,2]}');
  });

  it("strips undefined values", () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("handles strings with special chars", () => {
    const result = canonicalize({ key: 'hello "world"' });
    expect(result).toBe('{"key":"hello \\"world\\""}');
  });

  it("handles booleans", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });
});

// ── Contract Creation & Verification ────────────────────────────────────────

describe("Contract Creation", () => {
  it("creates a valid signed contract", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const subject = generateDID();
    const target = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    expect(contract.id).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(contract.types).toEqual(["VerifiableCredential", "PermissionContract"]);
    expect(contract.issuer).toBe(issuer.did);
    expect(contract.subject).toBe(subject.did);
    expect(contract.status).toBe("active");
    expect(contract.scope.actions).toEqual(["agent.message"]);
    expect(contract.scope.targetAgents).toEqual([target.did]);
    expect(contract.proof.type).toBe("Ed25519Signature2020");
    expect(contract.proof.proofValue).toMatch(/^z/); // multibase base58
  });

  it("signature verifies against issuer DID", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const subject = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["*"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    expect(service.verify(contract)).toBe(true);
  });

  it("tampered contract fails verification", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const subject = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // Tamper with the action
    const tampered: PermissionContract = {
      ...contract,
      scope: { ...contract.scope, actions: ["*"] },
    };

    expect(service.verify(tampered)).toBe(false);
  });

  it("wrong key fails verification", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const imposter = generateDID();
    const subject = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // Replace issuer DID with imposter — signature won't match
    const forged: PermissionContract = {
      ...contract,
      issuer: imposter.did,
    };

    expect(service.verify(forged)).toBe(false);
  });

  it("content-addressed ID is deterministic", async () => {
    // Same inputs at the same timestamp produce the same ID
    const { service } = createService();
    const issuer = generateDID();
    const subject = generateDID();
    const target = generateDID();

    // Fix time
    const now = new Date("2025-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const contract1 = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    // Create second service to avoid duplicate index
    const { service: service2 } = createService();
    const contract2 = await service2.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    expect(contract1.id).toBe(contract2.id);

    vi.useRealTimers();
  });

  it("includes constraints in scope when provided", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const subject = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["*"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
      constraints: { maxTokens: 1000, rateLimit: "10/min" },
    });

    expect(contract.scope.constraints).toEqual({
      maxTokens: 1000,
      rateLimit: "10/min",
    });
    // Constraints are part of the signed body — verify still passes
    expect(service.verify(contract)).toBe(true);
  });

  it("indexes contract in service", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const subject = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: subject.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    expect(service.size).toBe(1);
    expect(service.get(contract.id)).toEqual(contract);
  });
});

// ── Authorization Checking ──────────────────────────────────────────────────

describe("Authorization Check", () => {
  it("allows authorized action", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    const result = service.check({
      actorDid: agent.did,
      action: "agent.message",
      targetDid: target.did,
    });

    expect(result.allowed).toBe(true);
    expect(result.contractId).toBeDefined();
  });

  it("denies unauthorized action", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    const result = service.check({
      actorDid: agent.did,
      action: "agent.delegate", // not authorized
      targetDid: target.did,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("denies unauthorized target", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();
    const otherTarget = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    const result = service.check({
      actorDid: agent.did,
      action: "agent.message",
      targetDid: otherTarget.did, // not authorized
    });

    expect(result.allowed).toBe(false);
  });

  it("denies unknown actor", async () => {
    const { service } = createService();
    const unknown = generateDID();

    const result = service.check({
      actorDid: unknown.did,
      action: "agent.message",
      targetDid: unknown.did,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("No contracts found for actor");
  });

  it("wildcard action authorizes any action", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["*"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "soc.freeze",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);
  });

  it("prefix glob action matches subactions", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.*"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    // Should match
    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.delegate",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    // Should NOT match
    expect(
      service.check({
        actorDid: agent.did,
        action: "soc.freeze",
        targetDid: target.did,
      }).allowed,
    ).toBe(false);
  });

  it("wildcard target authorizes any agent", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    const target1 = generateDID();
    const target2 = generateDID();

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target1.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target2.did,
      }).allowed,
    ).toBe(true);
  });

  it("multiple actions in one contract", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message", "agent.delegate", "agent.command"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.delegate",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "soc.freeze",
        targetDid: target.did,
      }).allowed,
    ).toBe(false);
  });

  it("multiple target agents in one contract", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target1 = generateDID();
    const target2 = generateDID();
    const target3 = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target1.did, target2.did],
      durationMs: 3600_000,
    });

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target1.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target2.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target3.did,
      }).allowed,
    ).toBe(false);
  });
});

// ── Cross-Identity Isolation ────────────────────────────────────────────────

describe("Cross-Identity Isolation", () => {
  it("contract for Alice does not authorize Bob", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const alice = generateDID();
    const bob = generateDID();
    const target = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: alice.did,
      actions: ["*"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // Alice is authorized
    expect(
      service.check({
        actorDid: alice.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    // Bob is NOT authorized
    expect(
      service.check({
        actorDid: bob.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(false);
  });
});

// ── Expiration ──────────────────────────────────────────────────────────────

describe("Contract Expiration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("active contract becomes expired after TTL", async () => {
    const now = new Date("2025-06-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 60_000, // 1 minute
    });

    // Should be active now
    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    // Advance past expiration
    vi.setSystemTime(new Date("2025-06-01T12:01:01.000Z"));

    // Should be expired
    const result = service.check({
      actorDid: agent.did,
      action: "agent.message",
      targetDid: target.did,
    });
    expect(result.allowed).toBe(false);

    // Contract status updated lazily
    expect(service.get(contract.id)?.status).toBe("expired");
  });

  it("listForSubject excludes expired contracts", async () => {
    const now = new Date("2025-06-01T12:00:00.000Z");
    vi.setSystemTime(now);

    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();

    // Short-lived contract
    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 60_000,
    });

    // Long-lived contract
    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.delegate"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 86_400_000, // 24 hours
    });

    expect(service.listForSubject(agent.did)).toHaveLength(2);

    // Advance past short-lived expiration
    vi.setSystemTime(new Date("2025-06-01T12:01:01.000Z"));

    expect(service.listForSubject(agent.did)).toHaveLength(1);
    expect(service.listForSubject(agent.did)[0].scope.actions).toEqual(["agent.delegate"]);
  });
});

// ── Revocation ──────────────────────────────────────────────────────────────

describe("Contract Revocation", () => {
  it("revoked contract denies authorization", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    // Should be authorized
    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);

    // Revoke
    const revoked = await service.revoke(contract.id, issuer.did);
    expect(revoked).toBe(true);

    // Should be denied
    expect(
      service.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(false);

    expect(service.get(contract.id)?.status).toBe("revoked");
  });

  it("revoke returns false for non-existent contract", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const result = await service.revoke("nonexistent", issuer.did);
    expect(result).toBe(false);
  });

  it("revoke returns false for already revoked contract", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["*"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    await service.revoke(contract.id, issuer.did);
    const result = await service.revoke(contract.id, issuer.did);
    expect(result).toBe(false);
  });
});

// ── Register (Import) ───────────────────────────────────────────────────────

describe("Contract Registration", () => {
  it("registers an existing contract for lookup", async () => {
    const { service: service1 } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    const contract = await service1.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    // New service — starts empty
    const { service: service2 } = createService();
    expect(service2.size).toBe(0);

    // Register the contract
    service2.register(contract);
    expect(service2.size).toBe(1);

    // Check works in the new service
    expect(
      service2.check({
        actorDid: agent.did,
        action: "agent.message",
        targetDid: target.did,
      }).allowed,
    ).toBe(true);
  });
});

// ── List Operations ─────────────────────────────────────────────────────────

describe("List Operations", () => {
  it("listAll returns all contracts regardless of status", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();

    const c1 = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.delegate"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    await service.revoke(c1.id, issuer.did);

    // listAll includes revoked
    expect(service.listAll()).toHaveLength(2);

    // listForSubject excludes revoked
    expect(service.listForSubject(agent.did)).toHaveLength(1);
  });

  it("get returns null for unknown ID", () => {
    const { service } = createService();
    expect(service.get("nonexistent")).toBeNull();
  });
});

// ── Ledger Integration ──────────────────────────────────────────────────────

describe("Ledger Integration", () => {
  it("records contract.create event on ledger", async () => {
    const { service, events } = createService({ withLedger: true });
    const issuer = generateDID();
    const agent = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // The event callback should have fired
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("contract.create");
    expect(events[0].actorDid).toBe(issuer.did);
  });

  it("records contract.revoke event on ledger", async () => {
    const { service, events } = createService({ withLedger: true });
    const issuer = generateDID();
    const agent = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    await service.revoke(contract.id, issuer.did);

    expect(events).toHaveLength(2);
    expect(events[0].action).toBe("contract.create");
    expect(events[1].action).toBe("contract.revoke");
    expect(events[1].actorDid).toBe(issuer.did);
  });

  it("works without ledger (no events recorded)", async () => {
    const { service } = createService({ withLedger: false });
    const issuer = generateDID();
    const agent = generateDID();

    const contract = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["*"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // Should not throw
    await service.revoke(contract.id, issuer.did);
    expect(service.get(contract.id)?.status).toBe("revoked");
  });
});

// ── Multiple Contracts ──────────────────────────────────────────────────────

describe("Multiple Contracts", () => {
  it("first matching contract wins", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    const c1 = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message", "agent.delegate"],
      targetAgents: [target.did],
      durationMs: 7200_000,
    });

    const result = service.check({
      actorDid: agent.did,
      action: "agent.message",
      targetDid: target.did,
    });

    expect(result.allowed).toBe(true);
    expect(result.contractId).toBe(c1.id);
  });

  it("falls through to second contract when first doesn't match", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const agent = generateDID();
    const target = generateDID();

    // First contract: only agent.message
    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    // Second contract: only agent.delegate
    const c2 = await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.delegate"],
      targetAgents: [target.did],
      durationMs: 3600_000,
    });

    const result = service.check({
      actorDid: agent.did,
      action: "agent.delegate",
      targetDid: target.did,
    });

    expect(result.allowed).toBe(true);
    expect(result.contractId).toBe(c2.id);
  });

  it("contracts for different subjects are isolated", async () => {
    const { service } = createService();
    const issuer = generateDID();
    const ceo = generateDID();
    const cfo = generateDID();
    const research = generateDID();

    // CEO can message anyone
    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: ceo.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // CFO can only message Research
    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: cfo.did,
      actions: ["agent.message"],
      targetAgents: [research.did],
      durationMs: 3600_000,
    });

    // CEO → anyone: allowed
    expect(
      service.check({
        actorDid: ceo.did,
        action: "agent.message",
        targetDid: research.did,
      }).allowed,
    ).toBe(true);

    expect(
      service.check({
        actorDid: ceo.did,
        action: "agent.message",
        targetDid: cfo.did,
      }).allowed,
    ).toBe(true);

    // CFO → Research: allowed
    expect(
      service.check({
        actorDid: cfo.did,
        action: "agent.message",
        targetDid: research.did,
      }).allowed,
    ).toBe(true);

    // CFO → CEO: denied
    expect(
      service.check({
        actorDid: cfo.did,
        action: "agent.message",
        targetDid: ceo.did,
      }).allowed,
    ).toBe(false);
  });
});

// ── Content Store Persistence ───────────────────────────────────────────────

describe("Content Store Persistence", () => {
  it("persists contract to content store on create", async () => {
    const { service, store } = createService();
    const issuer = generateDID();
    const agent = generateDID();

    await service.create({
      issuerDid: issuer.did,
      issuerPrivateKey: issuer.privateKey,
      subjectDid: agent.did,
      actions: ["agent.message"],
      targetAgents: ["*" as unknown as DID],
      durationMs: 3600_000,
    });

    // Content store should have the contract
    const keys = await store.list("contracts/");
    expect(keys.length).toBe(1);
  });
});
