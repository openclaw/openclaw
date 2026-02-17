# Identity Architecture

**Layer 1 of The Six Fingered Man governance framework.**

> Identity is the foundation. Without provable identity, there is no accountability,
> no authorization, no audit trail, and no trust. Every other layer depends on this one.

---

## Table of Contents

1. [Why Identity Matters](#why-identity-matters)
2. [The Standards Stack](#the-standards-stack)
3. [Decentralized Identifiers (DIDs)](#decentralized-identifiers-dids)
4. [DID Methods We Use](#did-methods-we-use)
5. [Verifiable Credentials (VCs)](#verifiable-credentials-vcs)
6. [Identity Types in The Six Fingered Man](#identity-types-in-the-six-fingered-man)
7. [How Identity Flows Through the System](#how-identity-flows-through-the-system)
8. [Human Authentication](#human-authentication)
9. [Agent Authentication](#agent-authentication)
10. [Device Enrollment](#device-enrollment)
11. [Integration With Other Layers](#integration-with-other-layers)
12. [Key Lifecycle Management](#key-lifecycle-management)
13. [Interoperability](#interoperability)
14. [Implementation Reference](#implementation-reference)

---

## Why Identity Matters

Every action in a governed AI system needs to answer four questions:

1. **Who** did this? (identity)
2. **Were they allowed** to do it? (authorization)
3. **Can we prove** it happened? (audit)
4. **Can anyone tamper** with the record? (integrity)

All four depend on cryptographic identity. Without it:

- An agent could impersonate another agent
- A human command could be forged by anyone who controls the message channel
- The audit ledger could be filled with unsigned, unverifiable entries
- Authorization checks would rely on channel trust (phone number, username) rather than cryptographic proof

The 2023 blog post scenario illustrates this: two agents coordinated to publish damaging content. With identity, every message between agents is signed. The permission system can verify "does the sender have an active contract authorizing this communication?" If the answer is no, the message is rejected — not because of a firewall rule, but because the cryptographic proof of authorization is missing.

---

## The Standards Stack

Identity in The Six Fingered Man is built on three W3C standards:

```
┌─────────────────────────────────────────────────┐
│           Verifiable Presentations (VPs)         │
│     "Here are my credentials, verify them"       │
├─────────────────────────────────────────────────┤
│           Verifiable Credentials (VCs)           │
│     "This agent is authorized to do X"           │
│     "This human is an operator at scope Y"       │
├─────────────────────────────────────────────────┤
│         Decentralized Identifiers (DIDs)         │
│     "I am did:key:z6Mk..."                       │
│     "Verify me by resolving my DID Document"     │
├─────────────────────────────────────────────────┤
│              Ed25519 Cryptography                │
│     Private key (sign) / Public key (verify)     │
└─────────────────────────────────────────────────┘
```

Each layer builds on the one below:

- **Ed25519** provides the raw cryptographic operations (sign, verify)
- **DIDs** wrap public keys in a standard, self-describing format
- **VCs** use DIDs to issue signed claims ("this agent has permission X")
- **VPs** bundle VCs for presentation to a verifier

We implement all four layers. The bottom two (Ed25519 + DIDs) are in the identity module. The top two (VCs + VPs) are in the contracts module, built on top of identity.

---

## Decentralized Identifiers (DIDs)

### What Is a DID?

A DID is a globally unique identifier that the holder controls. Unlike a username (controlled by a platform), an email (controlled by a provider), or a government ID (controlled by a state), a DID is controlled by whoever holds the private key.

A DID looks like this:

```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
│   │   │
│   │   └── Method-specific identifier (the encoded public key)
│   └────── Method (how to resolve this DID)
└────────── Scheme (always "did")
```

### DID Documents

Every DID resolves to a **DID Document** — a JSON structure that describes what the identity can do:

```json
{
  "@context": "https://www.w3.org/ns/did/v1",
  "id": "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  "verificationMethod": [
    {
      "id": "did:key:z6Mk...#z6Mk...",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:key:z6Mk...",
      "publicKeyMultibase": "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
    }
  ],
  "authentication": ["did:key:z6Mk...#z6Mk..."],
  "assertionMethod": ["did:key:z6Mk...#z6Mk..."]
}
```

The document tells you:

- **verificationMethod** — the public key(s) associated with this identity
- **authentication** — which key(s) can prove "I am this DID" (login, challenge-response)
- **assertionMethod** — which key(s) can make signed claims (issue VCs, sign ledger entries)

For `did:key`, the document is deterministically derived from the DID itself — no network call, no registry, no database lookup. You decode the DID, extract the public key, and construct the document.

### How Resolution Works

```
                   did:key                          did:web
                   ──────                           ───────
Input:     did:key:z6Mk...                  did:web:example.com:agents:ceo

Step 1:    Decode base58btc                 Construct URL:
           from "z6Mk..."                  https://example.com/agents/ceo/did.json

Step 2:    Strip multicodec prefix          HTTP GET that URL
           (0xed01 = Ed25519)

Step 3:    Raw 32-byte public key           Parse JSON response

Step 4:    Construct DID Document            Return DID Document

Network:   None (pure math)                 HTTPS fetch

Trust:     Key itself IS the identity       Domain controls the document
```

### Why Not Just Use Raw Public Keys?

We already have Ed25519 public keys in auth-cli. Adding the DID format costs almost nothing (it's a prefix + encoding), but gains:

1. **Self-describing** — The multicodec prefix tells any parser "this is Ed25519" without out-of-band negotiation
2. **Standard format** — Any system that implements the DID spec can verify our identities
3. **Method agility** — Start with `did:key`, add `did:web` or chain-anchored methods later without changing the interfaces
4. **Ecosystem compatibility** — ERC-8004, IETF Agent Name Service, EU Digital Identity Wallets all speak DID

---

## DID Methods We Use

### `did:key` — The Default

Used for: **Agents, Humans, Devices**

```
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

- Generated from an Ed25519 keypair
- No registry, no network, no blockchain
- Identity IS the public key — you can verify it offline
- Deterministic resolution — same DID always produces same document
- Cannot be revoked externally (the holder controls it absolutely)

**How the encoding works:**

```
1. Generate Ed25519 keypair
   Private: 64 bytes (held secret)
   Public:  32 bytes (shared)

2. Multicodec prefix for Ed25519: 0xed 0x01
   Prepended to public key: [0xed, 0x01, ...32 bytes...]

3. Multibase encode as base58btc (prefix 'z')
   Result: z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK

4. Prepend "did:key:"
   Final: did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

**To resolve** (extract the public key):

```
1. Strip "did:key:" prefix
2. Multibase decode (strip 'z', decode base58btc)
3. Strip multicodec prefix (0xed 0x01)
4. Result: 32-byte Ed25519 public key
```

### `did:web` — For Organizations

Used for: **Tenants (companies)**

```
did:web:colleen-energy.com
did:web:nerdplanet.com:projects:black-hole-registry
```

- DID Document hosted at the organization's domain
- `did:web:example.com` resolves to `https://example.com/.well-known/did.json`
- `did:web:example.com:path:to` resolves to `https://example.com/path/to/did.json`
- Domain ownership proves organizational identity
- Can be updated by the domain owner (mutable, unlike `did:key`)

**Why use `did:web` for tenants?**

A tenant like "Colleen Energy LLC" wants their identity to be verifiable against their domain. Anyone can confirm that `did:web:colleen-energy.com` is controlled by whoever controls `colleen-energy.com`. This is similar to how TLS certificates work — domain control proves organizational identity.

Agents and humans use `did:key` because their identity is personal and cryptographic. Organizations use `did:web` because their identity is domain-bound and institutional.

### Methods We Don't Use (But Interoperate With)

| Method     | What It Is                   | Why We Don't Use It                  | Interop Story                                                    |
| ---------- | ---------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `did:ethr` | Ethereum-anchored identity   | Requires gas costs, chain dependency | Agents can register in ERC-8004 registries using their `did:key` |
| `did:ion`  | Bitcoin-anchored (Microsoft) | Heavy infrastructure                 | Could resolve ION DIDs when verifying external credentials       |
| `did:peer` | Peer-to-peer, no anchor      | Good for ephemeral sessions          | Could use for agent-to-agent session establishment               |

---

## Verifiable Credentials (VCs)

### What Is a VC?

A Verifiable Credential is a digitally signed claim made by one identity about another. It's the digital equivalent of a signed certificate or authorization letter.

```
Physical world:                          Digital equivalent:
  ┌──────────────────────┐               ┌──────────────────────────────────┐
  │ AUTHORIZATION LETTER  │               │ Verifiable Credential            │
  │                       │               │                                  │
  │ I, Jay (CEO),         │               │ issuer: did:key:z6Mk...(Jay)    │
  │ authorize Agent       │               │ subject: did:key:z6Mr...(Agent) │
  │ "Research" to access  │               │ scope: research.execute          │
  │ the BHR database      │               │ expires: 2026-03-01              │
  │ until March 1, 2026.  │               │ proof: Ed25519Signature(...)     │
  │                       │               │                                  │
  │ Signed: Jay ✍️         │               │ Cryptographically verifiable     │
  └──────────────────────┘               └──────────────────────────────────┘
```

### VC Structure

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "PermissionContract"],
  "issuer": "did:key:z6MkJay...",
  "issuanceDate": "2026-02-16T00:00:00Z",
  "expirationDate": "2026-03-01T00:00:00Z",
  "credentialSubject": {
    "id": "did:key:z6MkResearch...",
    "scope": "research.execute",
    "actions": ["read", "browser", "sessions_send"],
    "constraints": {
      "targetAgents": ["did:key:z6MkCEO..."],
      "maxMessagesPerHour": 20
    }
  },
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:key:z6MkJay...#z6MkJay...",
    "created": "2026-02-16T00:00:00Z",
    "proofValue": "z58DAdFfa9..."
  }
}
```

**To verify this credential:**

1. Extract the `issuer` DID: `did:key:z6MkJay...`
2. Resolve it to get the public key (decode the `did:key`)
3. Verify the `proof.proofValue` signature against the credential content using that public key
4. Check `expirationDate` hasn't passed
5. Check the issuer has authority to grant this permission (check their grants)

### How We Use VCs

| Use Case                        | VC Type            | Issuer                         | Subject      |
| ------------------------------- | ------------------ | ------------------------------ | ------------ |
| Agent permission to communicate | PermissionContract | Human (operator)               | Agent        |
| Agent delegation authority      | DelegationContract | Agent (with standing contract) | Agent        |
| Human role assignment           | PermissionGrant    | Human (owner)                  | Human        |
| Device enrollment               | DeviceCredential   | Human (authorizer)             | Device       |
| Maturity promotion              | MaturityCredential | Human (owner)                  | Agent        |
| Meeting authorization           | MeetingContract    | Human or Agent (CEO)           | Agent roster |

Every one of these is a signed claim that can be independently verified by any party with access to the issuer's DID.

---

## Identity Types in The Six Fingered Man

### Who Gets What

| Entity                | DID Method | Why                            | Example                        |
| --------------------- | ---------- | ------------------------------ | ------------------------------ |
| **Tenant** (company)  | `did:web`  | Domain-verifiable org identity | `did:web:nerdplanet.com`       |
| **Agent** (AI)        | `did:key`  | Self-sovereign, no registry    | `did:key:z6MkCEO...`           |
| **Human** (person)    | `did:key`  | Self-sovereign, portable       | `did:key:z6MkJay...`           |
| **Device** (enrolled) | `did:key`  | Per-device keypair             | `did:key:z6MkYubiKey...`       |
| **Platform** (LHS)    | `did:web`  | Domain-verifiable service      | `did:web:lefthandsecurity.com` |

### Identity Hierarchy

```
Tenant: did:web:nerdplanet.com
│
├── Human: did:key:z6MkJay...
│   ├── Device: did:key:z6MkJayMacBook...
│   ├── Device: did:key:z6MkJayYubiKey...
│   └── Grants: [owner@tenant, operator@project:bhr]
│
├── Agent (tenant-scoped): did:key:z6MkCEO...
│   └── Role: CEO, Model: deepseek-r1:70b
│
├── Agent (tenant-scoped): did:key:z6MkCOO...
│   └── Role: COO, Model: qwen2.5:72b
│
└── Project: Black Hole Registry
    ├── Agent (project-scoped): did:key:z6MkResearch...
    │   └── Role: Research, Model: deepseek-r1:32b
    └── Agent (project-scoped): did:key:z6MkSecurity...
        └── Role: Security, Model: ...
```

Every entity in this tree has its own keypair. Every interaction is signed. Every signature is verifiable against the actor's DID.

---

## How Identity Flows Through the System

### Scenario: Human Commands an Agent

```
Jay wants Research agent to analyze a dataset.

1. Jay types command on his MacBook
   ├── MacBook signs the message with its device key
   └── Signed payload: { command, deviceDid, timestamp }

2. Gateway receives the signed message
   ├── Resolves device DID → gets device public key
   ├── Verifies signature → authentic message from this device
   ├── Looks up device → belongs to Human "Jay" (did:key:z6MkJay...)
   └── Verified: this message is from Jay, from his MacBook

3. Authorization check
   ├── What is Jay trying to do? → command Research agent
   ├── Research agent scope → project:bhr
   ├── Does Jay have a grant? → operator@project:bhr ✓
   ├── Grant conditions: requirePhishResistant=true
   ├── MacBook auth method: keypair → phishResistant=true ✓
   └── Authorized

4. Ledger entry
   ├── actorDid: did:key:z6MkJay...
   ├── actorType: human
   ├── authContext: { method: "keypair", deviceDid: did:key:z6MkMacBook...,
   │                  ip: "73.x.x.x", geo: { country: "US", city: "Austin" },
   │                  grantUsed: "grant-abc123" }
   ├── action: "agent.command"
   ├── scope: { type: "project", projectId: "bhr" }
   └── Signed by Jay's key, countersigned by platform validator

5. Command delivered to Research agent
   ├── Agent verifies the command is signed by an authorized human
   ├── Agent executes the task
   └── Agent signs its own ledger entries as it works
```

### Scenario: Agent-to-Agent Communication

```
CEO agent wants to delegate a task to Research agent.

1. CEO agent prepares a delegation message
   ├── Signs with its own key (did:key:z6MkCEO...)
   └── Payload: { to: did:key:z6MkResearch..., task: "...", delegationId: "..." }

2. Communication Authority intercepts
   ├── Does CEO have an active PermissionContract?
   ├── Contract: issuer=did:key:z6MkJay... (human authorized it)
   │             subject=did:key:z6MkCEO...
   │             scope.targetAgents includes did:key:z6MkResearch...
   │             scope.actions includes "sessions_send"
   │             expiresAt: 2026-03-01 (still valid)
   ├── Verify contract proof → Jay's signature is valid ✓
   └── Authorized

3. Ledger entry
   ├── actorDid: did:key:z6MkCEO...
   ├── actorType: agent
   ├── authContext: { method: "agent-key" }
   ├── action: "agent.delegate"
   └── Scope, payload, signatures...

4. Message delivered to Research agent
   ├── Research verifies the message is signed by CEO's DID
   ├── Research verifies CEO has an active contract for this interaction
   └── Research proceeds with the task
```

### Scenario: Blocked Communication

```
Engineering agent tries to message Marketing agent directly.

1. Engineering signs and sends a message

2. Communication Authority intercepts
   ├── Does Engineering have a PermissionContract targeting Marketing?
   ├── Search active contracts for subject=did:key:z6MkEngineering...
   │   where scope.targetAgents includes did:key:z6MkMarketing...
   └── No matching contract found

3. DENIED
   ├── Ledger entry: action="agent.message", status=DENIED
   ├── SOC alert: "Unauthorized communication attempt"
   ├── Dashboard: red X on Engineering→Marketing path
   └── Engineering receives: "No active permission contract for this target"

4. No message delivered. Blog post scenario prevented.
```

---

## Human Authentication

Humans interact with the system through message channels (Signal, SMS, dashboard). Channels can be compromised. Identity verification ensures that even if a channel is taken over, an attacker cannot issue commands.

### Three Authentication Factors

```
Factor 1: Something you HAVE (device with enrolled keypair)
Factor 2: Something you ARE/DO (FIDO biometric or physical key press)
Factor 3: Something you KNOW (TOTP code — weakest, fallback only)
```

### Authentication Flow

```
Human sends a command via Signal
│
├── Is the message signed by an enrolled device key?
│   │
│   ├── YES (device cert present)
│   │   ├── Resolve device DID → verify signature
│   │   ├── Look up device → find linked human
│   │   ├── Check grant conditions
│   │   │   ├── requirePhishResistant? → check device.phishResistant
│   │   │   ├── require2FA? → was FIDO/TOTP used in addition to device key?
│   │   │   └── allowedHours? → check current time
│   │   └── All conditions met → AUTHORIZED
│   │
│   └── NO (no device cert — raw channel message)
│       ├── Trigger 2FA challenge
│       │   ├── FIDO: send WebAuthn challenge → user touches hardware key
│       │   ├── TOTP: send code prompt → user enters 6-digit code
│       │   └── Keypair: send nonce → user signs with dem-auth CLI
│       ├── Verify 2FA response
│       ├── If grant requires phishResistant and only TOTP available → DENY
│       └── 2FA verified → look up human → check grants → AUTHORIZED
│
└── Log everything to ledger (success or failure, with full auth context)
```

### Phish-Resistant vs. Non-Phish-Resistant

| Method                         | Phish Resistant | Why                                                                                                                                                              |
| ------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FIDO** (YubiKey, Touch ID)   | Yes             | Challenge is origin-bound. A phishing site at `evil.com` gets a response bound to `evil.com`, not the real service. Cannot be relayed.                           |
| **Keypair** (auth-cli signing) | Yes             | Challenge is signed locally with a key that never leaves the device. The signature is bound to the specific challenge nonce. Cannot be replayed.                 |
| **TOTP** (authenticator app)   | No              | 6-digit codes can be intercepted in transit (real-time phishing proxies). Attacker shows you a fake login, you type the code, they relay it to the real service. |

High-security grants (owner, operator on sensitive scopes) should require `requirePhishResistant: true`, which means FIDO or keypair. TOTP is a fallback for observer-level access or low-sensitivity operations.

---

## Agent Authentication

Agents authenticate differently from humans. An agent's identity IS its keypair — there's no "person behind the keyboard" to verify.

### How Agents Prove Identity

```
Agent wants to send a message or take an action:

1. Agent constructs the action payload
2. Agent signs the payload with its Ed25519 private key
3. Receiving system verifies signature against agent's DID
4. If valid → identity confirmed, proceed to authorization check
```

### Agent Key Storage

Agent private keys are stored in the agent's workspace, protected by:

1. **File permissions** — `0o600` (owner read/write only), same as auth-cli
2. **Container isolation** — Each agent runs in its own container (Layer 4: Compute)
3. **Network isolation** — Agent containers cannot access each other's filesystems (Layer 5: Network)

An agent's private key never leaves its compute environment. Signing happens locally within the agent's container.

### Agent Identity Verification (by other agents)

When Agent A receives a message from Agent B:

1. Extract the claimed sender DID from the message
2. Verify the signature against that DID (resolve → extract pubkey → verify)
3. Check that the sender DID matches a known agent in the roster
4. Check that there's an active PermissionContract authorizing this communication

Steps 1-2 prove identity. Steps 3-4 prove authorization.

---

## Device Enrollment

Devices are the bridge between a human's digital identity and the physical world. Each enrolled device has its own keypair and authentication method.

### Enrollment Ceremony

```
1. Human (Jay) requests device enrollment
   ├── Must already be authenticated (existing device or bootstrap)
   ├── Provides: device name, device type (fido/keypair/totp)
   └── New device generates its own Ed25519 keypair

2. Authorization check
   ├── Does Jay have a grant that includes device enrollment?
   ├── Only humans with owner or operator role can enroll devices
   └── At the appropriate scope (tenant or project)

3. Device-specific registration
   ├── FIDO: WebAuthn registration ceremony
   │   └── Device provides credentialId + public key + attestation
   ├── Keypair: Device provides its public key (via dem-auth keygen)
   │   └── Challenge-response to prove possession of private key
   └── TOTP: Generate shared secret
       └── Store hashed secret, display QR code to human

4. Enrollment recorded
   ├── DeviceEnrollment created: { did, humanId, type, phishResistant, ... }
   ├── Ledger entry: action="device.enroll"
   │   authContext includes the device/method used to authorize enrollment
   └── Enrollment signed by both the enrolling human and the platform

5. Device is now active
   └── Can be used to authenticate commands from this human
```

### Device Revocation

```
Human loses a device or it's compromised:

1. Revocation request (from another enrolled device, or by an owner)
2. DeviceEnrollment.status → "revoked"
3. Ledger entry: action="device.revoke"
4. All pending actions authenticated by this device are invalidated
5. If the human has no remaining active devices:
   └── Human is effectively locked out until re-enrolled by an owner
```

### Bootstrap Problem

How does the first human enroll their first device? This is the bootstrap ceremony:

1. During tenant creation, the platform generates a one-time bootstrap token
2. The founding human uses this token to authenticate their first device enrollment
3. The bootstrap token is recorded on the ledger as the genesis entry
4. From this point forward, all enrollment requires an existing authenticated device

This is analogous to how a certificate authority creates its root certificate — the first identity is self-asserted, and all subsequent identities derive trust from it.

---

## Integration With Other Layers

Identity is Layer 1. Every other layer depends on it:

### Layer 2: Ledger

Every ledger entry includes `actorDid` and is signed by the actor's key. The ledger verifies signatures on write. Anyone can verify signatures on read by resolving the DID.

### Layer 3: Data

Data isolation is enforced per-tenant and per-project. The identity system tells the data layer "this request comes from did:key:z6Mk..., which belongs to tenant X, project Y." The data layer uses this to enforce schema boundaries.

### Layer 4: Compute

Container assignment is keyed on agent DID. Each agent's container holds its private key. The compute layer ensures no agent can access another agent's key material.

### Layer 5: Network

Permission contracts (VCs issued by authorized DIDs) are the gatekeeping mechanism. The Communication Authority resolves DIDs, verifies contract signatures, and checks expiration before allowing cross-agent messages.

### Layer 6: Sandbox

The behavioral SOC monitors actions by DID. Anomaly detection builds behavioral profiles per agent DID. When an agent's behavior deviates from its profile, the SOC fires an alert attributed to that specific DID.

---

## Key Lifecycle Management

### Key Generation

```
Agent onboarding:
  1. Generate Ed25519 keypair
  2. Derive did:key from public key
  3. Store private key in agent workspace (0o600 permissions)
  4. Register DID in tenant agent roster
  5. Log identity.create to ledger

Human onboarding:
  1. Human generates keypair (via auth-cli or platform)
  2. Derive did:key from public key
  3. Private key stays on human's device (never transmitted)
  4. Register DID in tenant human roster
  5. Log identity.create to ledger
```

### Key Rotation (Phase 2)

Over time, keys should be rotated. The rotation protocol:

```
1. Generate new keypair → new DID
2. Create a signed rotation statement:
   "did:key:OLD is being replaced by did:key:NEW"
   Signed by BOTH the old key and the new key
3. Log identity.rotate to ledger (with both signatures)
4. Update all references: agent roster, active contracts, grants
5. Grace period: old DID remains valid for verification of historical
   ledger entries, but cannot authorize new actions
6. After grace period: old DID is fully retired
```

This ensures that:

- Historical ledger entries signed by the old key remain verifiable
- The rotation is authorized (signed by the old key proves it wasn't hostile)
- The new key is proven to be controlled by the same entity

### Key Compromise Response

If a key is believed to be compromised:

```
1. Immediate: revoke all active PermissionContracts for the compromised DID
2. Immediate: freeze the agent/human (status → "suspended")
3. SOC alert: soc.freeze logged to ledger
4. Human owner must authorize:
   ├── Key rotation (generate new DID, migrate references)
   ├── Audit: review all ledger entries signed by compromised key
   │   since the suspected compromise date
   └── Re-issuance of contracts and grants to the new DID
5. Resume operations with new identity
```

---

## Interoperability

### ERC-8004 (Ethereum Agent Registry)

Our agents can optionally register in the ERC-8004 Identity Registry:

```
Agent DID:    did:key:z6MkCEO...
ERC-8004 ID:  NFT token with URI pointing to agent's registration file
Reputation:   Benchmark data posted to ERC-8004 Reputation Registry
Validation:   Sandbox results posted to ERC-8004 Validation Registry
```

This is a per-tenant opt-in. The agent's `did:key` is the canonical identity; the ERC-8004 registration is an additional publication for cross-platform discovery.

### IETF Agent Name Service (ANS)

Our DID Documents can be made discoverable via ANS:

```
ANS Record:
  name: "ceo.nerdplanet.lefthandsecurity.agents"
  did: "did:key:z6MkCEO..."
  capabilities: ["delegation", "planning", "synthesis"]
  endpoints: ["wss://gateway.nerdplanet.com:18789"]
  certificate: X.509 cert binding the ANS record to the DID
```

This enables cross-platform agent discovery — another platform's agents can find and verify our agents through ANS resolution.

### EU Digital Identity / eIDAS 2.0

The VC format we use for permission contracts is compatible with the European Digital Identity Wallet framework. If regulatory requirements emerge for AI agent identity (likely), our agents already carry W3C-standard credentials that can be verified by eIDAS-compliant systems.

The gap: eIDAS credentials require issuance by a trusted authority (government, regulated entity). Our VCs are self-issued within the governance framework. Bridging to eIDAS would require a trusted third party to attest to our agent identities — this is a future integration point, not a current requirement.

---

## Implementation Reference

### Module: `packages/governance/src/identity/did.ts`

```
Functions:
  generateDID()         → Create new Ed25519 keypair, return { did, privateKey, publicKey }
  didFromPublicKey()    → Encode existing public key as did:key
  resolveDID()          → Extract public key from did:key, construct DID Document
  signWithDID()         → Sign data with a DID's private key, return proof object
  verifyWithDID()       → Verify a signature against a DID
```

### Module: `packages/governance/src/identity/vc.ts` (Phase 2)

```
Functions:
  issueCredential()    → Create and sign a Verifiable Credential
  verifyCredential()   → Verify a VC's proof and check expiration
  revokeCredential()   → Mark a VC as revoked (ledger entry)
  presentCredentials() → Bundle VCs into a Verifiable Presentation
```

### Dependencies

- `@noble/ed25519` — Ed25519 sign/verify (already in use)
- `@noble/hashes` — SHA-512 for Ed25519, SHA-256 for hashing
- No additional dependencies for `did:key` (multibase/multicodec is byte manipulation)
- `did:web` resolution requires HTTP fetch (Node built-in, Phase 2)

### Type Definitions

All identity types are defined in `packages/governance/src/types.ts`:

- `DID` — Template literal type for did:key and did:web
- `DIDDocument` — W3C DID Document structure
- `VerificationMethod` — Ed25519 public key reference
- `AuthContext` — Authentication metadata for ledger entries
- `DeviceEnrollment` — Enrolled device with FIDO/keypair/TOTP
- `PermissionContract` — Verifiable Credential for agent authorization
