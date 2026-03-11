# NODE_INVOKE Trust Boundary and Enforcement Model

## Overview

The `NODE_INVOKE` ontology contract defines a trust boundary that splits authorization responsibility based on the **origin and destination** of node.invoke requests. This document clarifies the enforcement model across four distinct request paths and explains why each requires different protection mechanisms.

## Trust Boundary Split

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AGENT RUNTIME BOUNDARY                        │
│                         (ClarityBurst Gate)                          │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Agent Code / Tool Invocation                                │   │
│  │ ──────────────────────────────────────────────────────────  │   │
│  │ node.invoke (agent-callable) ──► MANDATORY NODE_INVOKE gate │   │
│  │                                                             │   │
│  │ • ClarityBurst pack verifies contract allowlist            │   │
│  │ • Contract signature validates invocation parameters        │   │
│  │ • Tripwire fail-closed on decision unavailable             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ▼                                       │
│                     [Internal Delivery]                              │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                    [Transport: no auth check]
                                 │
                         Gateway → Node-Host
                                 │
┌─────────────────────────────────────────────────────────────────────┐
│                      OPERATOR BOUNDARY                               │
│                  (Operator Scope Enforcement)                        │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Operator CLI / Direct Invocation                            │   │
│  │ ──────────────────────────────────────────────────────────  │   │
│  │ node.invoke (operator-direct) ──► OPERATOR SCOPE GATES      │   │
│  │                                                             │   │
│  │ • Operator authentication (identity + credentials)         │   │
│  │ • Operator role/permission checks                          │   │
│  │ • ACL enforcement on target node or target resource        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ▼                                       │
│                     [Internal Delivery]                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Four Request Paths

### 1. Agent Runtime node.invoke Paths

**Definition:** Requests originating from agent code or tool execution contexts within a running agent instance.

**Protection Mechanism:** **ClarityBurst NODE_INVOKE Gate** (Mandatory)

- The agent's ClarityBurst pack MUST contain a signed `NODE_INVOKE` contract
- The contract lists allowlisted node invocation patterns (method, resource class, parameter schema)
- At invocation time:
  - Router client verifies the ClarityBurst pack is loaded and has a valid NODE_INVOKE contract
  - Invocation parameters are validated against the contract's defined schema
  - If the decision is unavailable (router outage, missing pack, or allowlist mismatch), the gate fails closed
- **Boundary Implication:** All agent-callable node.invoke paths are treated as untrusted agent input until gated

### 2. Operator CLI node.invoke Paths

**Definition:** Requests initiated directly by operators through CLI, HTTP gateway, or other direct-invocation surfaces outside the agent runtime.

**Protection Mechanism:** **Operator Scope Enforcement** (Outside Agent Boundary)

- Operator identity must be authenticated (API key, OAuth token, or session credential)
- Operator permissions/roles determine whether they are authorized to invoke node operations
- ACL enforcement may apply per-resource or per-operation depending on deployment configuration
- **Boundary Implication:** Operator paths are explicitly **outside** the agent trust boundary; they rely on separate operator-level authorization

### 3. Gateway Internal node.invoke.request Delivery

**Definition:** Internal transport mechanism by which the gateway delivers validated node.invoke requests to node-host instances.

**Protection Mechanism:** **None (Transport Mechanism)**

- The gateway assumes that by this point, the request has already passed authorization gates (ClarityBurst or operator scope)
- This path is **not** an authorization entry point; it is a delivery conduit
- Node-host inbound reception does not re-evaluate authorization; it executes the request as pre-authorized by the gateway
- **Boundary Implication:** Authorization decisions are made upstream (at the agent or operator boundary); delivery is not a trust checkpoint

### 4. Node-Host Inbound Reception

**Definition:** Node-host process receiving a node.invoke.request message from the gateway.

**Protection Mechanism:** **Message Authentication / Transport Integrity** (Out of Scope for NODE_INVOKE Gate)

- Node-host validates that the message originated from the authorized gateway (transport-level verification)
- Node-host does NOT re-evaluate agent-side ClarityBurst decisions or operator-side scope decisions
- Execution proceeds with the authorization decision already made upstream
- **Boundary Implication:** Node-host is a policy execution layer, not a policy decision layer; trust is inherited from the gateway channel

## Enforcement Summary

| Path | Origin | Trust Boundary | Protection | Enforcement Point |
|------|--------|---|---|---|
| Agent runtime | Agent code/tools | **INSIDE** | ClarityBurst NODE_INVOKE gate | Router client (pre-invocation) |
| Operator CLI | Operator (direct) | **OUTSIDE** | Operator scope + auth | Gateway/API server |
| Gateway delivery | Authorized request | **POST-DECISION** | None (transport) | N/A (pre-authorized) |
| Node-host receive | Trusted gateway | **POST-DECISION** | Message transport integrity | Node-host (execution) |

## Key Principles

1. **Single Gating Point per Boundary:**
   - Agent requests are gated once (ClarityBurst pack) before reaching the gateway
   - Operator requests are gated once (operator auth + scope) at the operator interface
   - Subsequent delivery steps do not re-gate

2. **Fail-Closed Semantics for Agent Paths:**
   - If the ClarityBurst NODE_INVOKE decision is unavailable, the invocation **must** fail
   - Router unavailability or pack incompleteness triggers automatic rejection
   - This prevents agent code from circumventing policy during router degradation

3. **Operator Scope is Independent of Agent Policy:**
   - Operators may invoke node operations even if no agent has permission to do so
   - Operators may be restricted even if an agent's pack allows the operation
   - These are two separate authorization domains

4. **Transport is Not Policy:**
   - Gateway-to-node delivery mechanisms (mTLS, message signing, etc.) ensure integrity but do not enforce policy
   - Node-host execution assumes policy was validated upstream
   - Attackers cannot inject requests via the transport layer without first breaching the gateway (which is a different threat model)

## Related Documentation

- [`src/clarityburst/`](../../src/clarityburst/) — ClarityBurst implementation and NODE_INVOKE gate
- [`ontology-packs/NODE_INVOKE.json`](../../ontology-packs/NODE_INVOKE.json) — NODE_INVOKE contract schema
- [`docs/concepts/agent.md`](/concepts/agent) — Agent runtime model
