# SPEC: Agent-Scoped Access (Track B — Gateway Backend)

**Author:** Alex Neyman, bot
**Date:** 2026-02-14
**Status:** Draft
**Depends on:** Shared contract (below). No dependency on Track A at build time.
**Companion:** `kos/specs/SPEC-agent-centric-refactor.md` (Track A — kOS Frontend)

---

## Shared Contract

Both tracks depend on the following interface. This is the only coordination point.

### 1. `HelloOk.auth` (already exists in schema)

```typescript
auth: {
  deviceToken: string;
  role: string;       // "owner" | "operator" | "collaborator"
  scopes: string[];   // e.g. ["agents:*"] or ["agents:payme"]
  issuedAtMs?: number;
}
```

**Track B writes** `role` and `scopes` during device pairing approval. Today all connections get `role: "operator"`, `scopes: []`.
**Track A reads** these to determine what UI to show.

### 2. `agents.list` response (already exists)

```typescript
{
  defaultId: string;
  mainKey: string;
  scope: "per-sender" | "global";
  agents: AgentSummary[];  // Track B filters this based on connection scopes
}
```

**Track B filters** this server-side so collaborators only receive their scoped agents.
**Track A consumes** this as sole source of truth for agent tabs — never hardcodes.

### 3. Role semantics

| Role           | Meaning                                                    | Who issues it                            |
| -------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `owner`        | Full access. Local loopback / master token.                | Gateway auto-assigns                     |
| `operator`     | Full access. Existing paired devices. Backward compat.     | Current default for all paired devices   |
| `collaborator` | Agent-scoped. Can only see/interact with agents in scopes. | Track B — issued during pairing approval |

### 4. Scope convention

```
"agents:*"              → all agents (owner/operator default)
"agents:hackathon"      → only hackathon agent
"agents:payme"          → only PayMe agent
[]                      → no agent scopes declared = full access (backward compat)
```

Scopes are stored on device pairing records and baked into device tokens.

---

## Problem

Today, sharing an agent requires either:

- Giving someone your full gateway token (sees ALL agents, no scoping)
- Adding them to a Telegram/Slack group chat (clunky, not native)

There's no way to share a **specific agent** while keeping everything else private.

## Vision

Any agent on your gateway should be shareable with specific people. They connect via kOS, see only their scoped agents, and interact natively — chat, files, terminals — as if it were their own.

```
┌─────────────┐     ┌──────────────┐
│  Alex (kOS)  │     │ Carson (kOS)  │
│  owner       │     │ collaborator  │
│  sees: all   │     │ sees: hack    │
└──────┬───────┘     └──────┬────────┘
       │  Tailscale          │  Tailscale
       ▼                     ▼
┌──────────────────────────────────────┐
│   OpenClaw Gateway (Mac Studio)      │
│                                      │
│  Scope Enforcement Middleware         │
│  ┌────────┐ ┌──────────┐ ┌────────┐ │
│  │  bot   │ │hackathon │ │ PayMe  │ │
│  │(owner) │ │(shared)  │ │(shared)│ │
│  └────────┘ └──────────┘ └────────┘ │
└──────────────────────────────────────┘
```

## Existing Infrastructure

| Component                   | Status | Notes                                                            |
| --------------------------- | ------ | ---------------------------------------------------------------- |
| Multi-agent config          | ✅     | `openclaw.json` → `agents.list[]`                                |
| Agent CRUD via RPC          | ✅     | `agents.list`, `agents.create`, `agents.update`, `agents.delete` |
| Agent files via RPC         | ✅     | `agents.files.list`, `agents.files.get`, `agents.files.set`      |
| Device pairing flow         | ✅     | Ed25519 keypair, approve/reject, device tokens                   |
| Roles in handshake          | ✅     | `"operator"` / `"node"` in connect params                        |
| Scopes in handshake         | ✅     | `scopes: string[]` in connect, stored on device token            |
| Scope validation on connect | ✅     | Server checks requested scopes against paired scopes             |
| HelloOk auth block          | ✅     | Returns `role` + `scopes` to client                              |
| Tailscale serve             | ✅     | `gateway.auth.allowTailscale: true`                              |
| Per-sender sessions         | ✅     | Each kOS client gets own session per agent                       |

## What's Missing (This Spec Delivers)

| Component                    | What's Needed                                  |
| ---------------------------- | ---------------------------------------------- |
| Scope enforcement on RPCs    | Filter `agents.list`, reject out-of-scope RPCs |
| Collaborator role            | New role with restricted permissions           |
| Pairing with scope selection | Pick role + agents when approving a device     |
| Invite system                | Create shareable invite codes scoped to agents |
| kOS invite redemption        | Connect via invite code                        |

---

## Detailed Design

### 1. Scope Enforcement Utilities

**New file:** `src/gateway/scope-utils.ts`

```typescript
/** Check if connection has access to a given agent */
export function connectionHasAgentAccess(scopes: string[], agentId: string): boolean {
  const agentScopes = scopes.filter((s) => s.startsWith("agents:"));
  if (agentScopes.length === 0) return true; // no agent scopes = full access (backward compat)
  if (agentScopes.includes("agents:*")) return true;
  return agentScopes.includes(`agents:${agentId}`);
}

/** Check if connection is owner/operator */
export function connectionIsOwner(role: string | undefined): boolean {
  if (!role) return true; // legacy = owner
  return role === "owner" || role === "operator";
}

/** Filter agent list by connection scopes */
export function filterAgentsForConnection(
  agents: AgentSummary[],
  scopes: string[],
): AgentSummary[] {
  const agentScopes = scopes.filter((s) => s.startsWith("agents:"));
  if (agentScopes.length === 0) return agents;
  if (agentScopes.includes("agents:*")) return agents;
  const allowedIds = new Set(agentScopes.map((s) => s.replace("agents:", "")));
  return agents.filter((a) => allowedIds.has(a.id));
}
```

### 2. RPC Method Scope Checks

Every agent-targeted RPC needs a scope check. The connection object already carries `scopes` from the handshake.

| Method                        | Check                                          | Reject with                  |
| ----------------------------- | ---------------------------------------------- | ---------------------------- |
| `agents.list`                 | Filter results via `filterAgentsForConnection` | N/A (filtered, not rejected) |
| `agents.create`               | `connectionIsOwner(role)`                      | `FORBIDDEN`                  |
| `agents.update`               | `connectionIsOwner(role)`                      | `FORBIDDEN`                  |
| `agents.delete`               | `connectionIsOwner(role)`                      | `FORBIDDEN`                  |
| `agents.files.*`              | `connectionHasAgentAccess(scopes, agentId)`    | `FORBIDDEN`                  |
| `chat.send`                   | `connectionHasAgentAccess(scopes, agentId)`    | `FORBIDDEN`                  |
| `sessions.list`               | Filter results by accessible agents            | N/A (filtered)               |
| `sessions.history`            | Check session's agent is accessible            | `FORBIDDEN`                  |
| `sessions.patch/delete/reset` | Check session's agent is accessible            | `FORBIDDEN`                  |
| `cron.*`                      | Filter/check by agent binding                  | `FORBIDDEN`                  |
| `config.*`                    | `connectionIsOwner(role)`                      | `FORBIDDEN`                  |
| `device.pair.*`               | `connectionIsOwner(role)`                      | `FORBIDDEN`                  |
| `skills.status`               | Filter by accessible agents                    | N/A (filtered)               |

**Files to modify:**

- `src/gateway/server-methods/agents.ts` — filter `agents.list`, gate CRUD
- `src/gateway/server-methods/sessions.ts` — filter/gate session RPCs
- `src/gateway/server-methods/cron.ts` — filter/gate cron RPCs
- `src/gateway/server-methods/config.ts` — gate all config RPCs
- `src/gateway/server-methods/devices.ts` — gate pairing RPCs
- `src/gateway/server/ws-connection/message-handler.ts` — accept `"collaborator"` role

### 3. Pairing Flow Changes

#### Current

```
kOS connects → unknown device → pairing request
Owner approves → role=operator, scopes=[]
```

#### New

```
kOS connects → unknown device → pairing request
  Request may include: { requestedAgentIds: ["hackathon"] }

Owner sees approval UI:
  "Carson's MacBook wants access"
  Role: [Collaborator ▾]
  Agents: [✓ hackathon] [  PayMe] [  bot]
  [Approve] [Deny]

Owner approves → role=collaborator, scopes=["agents:hackathon"]
```

**Changes to `device.pair.approve` RPC:**

```typescript
// Existing params, add optional fields:
{
  requestId: string;
  role?: "operator" | "collaborator";  // NEW, default "operator"
  scopes?: string[];                    // NEW, default [] (full access)
}
```

Storage: device pairing records already have a `scopes` field. Just populate it.

**Files to modify:**

- `src/gateway/server-methods/devices.ts` — accept role + scopes in approve
- `src/infra/device-pairing.ts` — store role on pairing record
- `src/gateway/protocol/schema/devices.ts` — extend approve params schema

### 4. Invite System

#### Invite Creation RPC

```typescript
// New method: invite.create
// Params:
{
  agentIds: string[];         // which agents to grant
  role?: "collaborator";      // default collaborator
  maxUses?: number;           // default 1
  expiresInMs?: number;       // default 24h
}

// Result:
{
  inviteCode: string;         // e.g. "hack-2026-xK9m"
  inviteUrl: string;          // openclaw://join?code=hack-2026-xK9m&host=...
  expiresAtMs: number;
}
```

#### Invite Redemption

```
Carson opens kOS → "Join Agent" → enters invite code or URL
kOS connects with: { auth: { inviteCode: "hack-2026-xK9m" } }
Gateway resolves invite → knows agent scopes
Auto-creates pairing with pre-filled role + scopes
Owner can optionally require manual approval (configurable)
```

#### Invite Storage

```typescript
interface Invite {
  code: string;
  agentIds: string[];
  role: "collaborator" | "operator";
  createdByDeviceId: string;
  createdAtMs: number;
  expiresAtMs: number;
  maxUses: number;
  usedCount: number;
  usedBy: string[];
}
```

Stored as JSON in `~/.openclaw/invites.json` (alongside device pairing state).

**New files:**

- `src/gateway/invites.ts` — invite CRUD, validation, expiry
- `src/gateway/server-methods/invites.ts` — `invite.create`, `invite.list`, `invite.revoke` RPCs
- `src/gateway/protocol/schema/invites.ts` — TypeBox schemas

**Modified files:**

- `src/gateway/server/ws-connection/message-handler.ts` — handle `inviteCode` in auth during connect
- `src/gateway/protocol/schema/frames.ts` — add `inviteCode` to connect params

### 5. Default Agent Resolution

When a collaborator has access to exactly one agent:

- `agents.list` returns one agent
- That agent becomes their `defaultId`
- kOS Track A handles this naturally (one tab, land directly in agent view)

No special gateway logic needed — the filtering does the work.

---

## Implementation Tasks

### Task 1: Scope Enforcement (Pure Backend, Fully Testable)

**No UI changes. Full E2E test coverage.**

1. Create `src/gateway/scope-utils.ts` with `connectionHasAgentAccess`, `connectionIsOwner`, `filterAgentsForConnection`
2. Patch `agents.list` handler to filter by connection scopes
3. Add scope checks to all agent-targeted RPCs (chat, sessions, files, cron)
4. Add role checks to owner-only RPCs (config, agents CRUD, device pairing)
5. Accept `"collaborator"` role in handshake validation
6. E2E tests (see below)

### Task 2: Pairing with Scope Assignment

1. Extend `device.pair.approve` params: `role`, `scopes`
2. Store role + scopes on device pairing record
3. Ensure device token includes role + scopes
4. Update approval event payload so kOS can build UI for it
5. E2E tests

### Task 3: Invite System

1. Invite storage (`~/.openclaw/invites.json`)
2. `invite.create`, `invite.list`, `invite.revoke` RPCs
3. Invite redemption during connect handshake
4. Auto-populate scopes from invite during pairing
5. Expiry + usage tracking
6. E2E tests

### Task 4: kOS Pairing + Invite UI (Minimal Frontend)

**This is the ONLY frontend work in Track B.** Scoped narrowly:

1. Pairing approval dialog: add role dropdown + agent checkboxes
2. "Join Agent" entry point: invite code input → connect with invite
3. No navigation/layout changes (that's Track A)

---

## E2E Test Strategy

Spin up a test gateway, connect multiple WS clients with different device identities and scopes.

```typescript
describe("agent-scoped-access", () => {
  it("collaborator only sees scoped agents", async () => {
    const owner = await connectAsOwner();
    const collab = await connectAsCollaborator(["agents:hackathon"]);

    const ownerAgents = await owner.rpc("agents.list", {});
    const collabAgents = await collab.rpc("agents.list", {});

    expect(ownerAgents.agents.length).toBeGreaterThan(1);
    expect(collabAgents.agents).toHaveLength(1);
    expect(collabAgents.agents[0].id).toBe("hackathon");
  });

  it("collaborator cannot access out-of-scope agent", async () => {
    const collab = await connectAsCollaborator(["agents:hackathon"]);
    await expect(collab.rpc("agents.files.list", { agentId: "main" })).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN,
    });
  });

  it("collaborator cannot modify config", async () => {
    const collab = await connectAsCollaborator(["agents:hackathon"]);
    await expect(collab.rpc("config.get", {})).rejects.toMatchObject({
      code: ErrorCodes.FORBIDDEN,
    });
  });

  it("empty scopes = full access (backward compat)", async () => {
    const legacy = await connectWithScopes([]);
    const agents = await legacy.rpc("agents.list", {});
    expect(agents.agents.length).toBeGreaterThan(1);
  });

  it("invite code grants scoped access", async () => {
    const owner = await connectAsOwner();
    const { inviteCode } = await owner.rpc("invite.create", {
      agentIds: ["hackathon"],
      maxUses: 1,
    });

    const guest = await connectWithInvite(inviteCode);
    const agents = await guest.rpc("agents.list", {});
    expect(agents.agents).toHaveLength(1);
    expect(agents.agents[0].id).toBe("hackathon");
  });
});
```

### Manual Testing: Second kOS Instance

```bash
# Run a second kOS with fresh device identity
KOS_DEV_APP_NAME="kos-guest" npm run dev
# OR
cd ~/bot/openclaw/kos && npm run dev -- --user-data-dir=/tmp/kos-guest
```

This instance generates a new keypair, triggers pairing, and can be approved with collaborator role + agent scopes.

---

## Boundary with Track A

| Concern                             | Track A (this spec?)    | Track B (this spec)      |
| ----------------------------------- | ----------------------- | ------------------------ |
| Agent tabs in top bar               | ✅                      | ❌                       |
| Agent Home grid                     | ✅                      | ❌                       |
| Delete profiles/projects/workspaces | ✅                      | ❌                       |
| Shell.tsx / Sidebar.tsx rewrite     | ✅                      | ❌                       |
| `agent-store.ts`                    | ✅                      | ❌                       |
| `isOwner()` check in components     | ✅ (builds the gating)  | ✅ (makes it meaningful) |
| `agents.list` server-side filtering | ❌                      | ✅                       |
| Scope enforcement on RPCs           | ❌                      | ✅                       |
| `scope-utils.ts`                    | ❌                      | ✅                       |
| Collaborator role in handshake      | ❌                      | ✅                       |
| `device.pair.approve` with scopes   | ❌                      | ✅                       |
| Invite system (create/redeem)       | ❌                      | ✅                       |
| Pairing approval UI (role + agents) | ❌                      | ✅ (minimal kOS UI)      |
| "Join Agent" UI                     | ❌                      | ✅ (minimal kOS UI)      |
| `gateway-store.ts` add role/scopes  | ✅ (reads from HelloOk) | ❌ (already in HelloOk)  |

**Key rule:** Track A never touches `src/gateway/`. Track B never touches kOS layout/navigation components. The only kOS files Track B touches are the pairing approval dialog and a new "Join Agent" entry point.

---

## Open Questions

- [ ] **Auto-approve invites?** If an invite exists, should pairing be auto-approved? Probably yes — the invite IS the authorization.
- [ ] **Can collaborators see each other's sessions?** No — sessions are per-sender. But the agent carries context from all sessions in its memory.
- [ ] **Exec sandboxing for collaborators?** They can run exec on the host. Docker sandbox mode for untrusted users is future work. Kinetic team = trust-based.
- [ ] **Viewer role?** Read-only access (see sessions, can't chat). Defer to v2.
- [ ] **Should collaborators install skills?** No for now — owner curates.

---

## Appendix: Relevant Source Files

### Gateway (Track B touches these)

- `src/gateway/auth.ts` — token/password/tailscale verification
- `src/gateway/server/ws-connection/message-handler.ts` — connect handshake, role/scope
- `src/gateway/server-methods/agents.ts` — agent CRUD + file RPCs
- `src/gateway/server-methods/sessions.ts` — session RPCs
- `src/gateway/server-methods/devices.ts` — device pairing
- `src/gateway/protocol/schema/frames.ts` — HelloOk, connect params
- `src/gateway/protocol/schema/agents-models-skills.ts` — agent schemas
- `src/infra/device-pairing.ts` — pairing storage + token management

### kOS (Track B touches ONLY these)

- `kos/src/renderer/src/components/layout/DevicePairingDialog.tsx` (or equivalent) — add role + scope selection
- New: `kos/src/renderer/src/components/JoinAgent.tsx` — invite code entry
- `kos/src/renderer/src/gateway/client.ts` — pass `inviteCode` in connect params
