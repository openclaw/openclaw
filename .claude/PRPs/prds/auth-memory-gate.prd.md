# Auth Memory Gate — Cross-Channel Identity & Scoped Memory Retrieval

> **Revision 2 (2026-02-25)**: Split into two layers after codebase/community analysis.
> Layer 1 (`persist-user-identity`) — user persistence + identity unification — is implemented.
> Layer 2 (`auth-memory-gate`) — memory scoping using resolved identity — is future work.
> See `extensions/persist-user-identity/IDENTITY_CONTRACT.md` for the downstream integration spec.

## Problem Statement

Developers using OpenClaw as their AI stack across multiple communication channels (SMS, WhatsApp, chat API) cannot configure an agent with a memory plugin that injects user-relevant context across channels. The same person chatting via WhatsApp and via a web app is treated as two separate identities with no shared memory. Furthermore, memory plugins (memory-lancedb, memory-core) have zero per-user isolation — all memories are workspace-wide. There is no mechanism to verify a user's identity before retrieving their context, meaning any channel peer could potentially access memories stored from another channel.

## Evidence

- **memory-lancedb** (`extensions/memory-lancedb/index.ts:295`) stores to a single workspace-wide LanceDB path with no user/group filtering — all agents and sessions share one database
- **Plugin hook context** (`src/plugins/types.ts:321-327`) exposes `sessionKey` but NOT `userId`, `groupId`, or any canonical identity in `PluginHookAgentContext`
- **identityLinks** (`src/routing/session-key.ts:190-234`) exists for cross-channel DM session routing but does NOT propagate identity to memory plugins — it only consolidates session keys
- **No user-facing OAuth** exists — all OAuth extensions (google-gemini-cli-auth, minimax-portal-auth) are model-provider-facing, not end-user authentication
- **persist-postgres** (`extensions/persist-postgres/src/index.ts`) demonstrates scoped storage via `session_key` column but lacks identity-verified scoping
- **OpenClaw issue #18565** ("Per-user context files") — community recognizes the need for per-user identity but only proposes file-based `users/` directory
- **OpenClaw issue #15325** ("memory-lancedb per-agent isolation") — even basic agent-level memory isolation is unresolved
- **OpenClaw issue #24832** ("Cross-session shared context") — sessions are too isolated across channels for same user

## Proposed Solution — Two-Layer Architecture

**Layer 1: `persist-user-identity` (this PR)**

A PostgreSQL-backed user identity plugin that:

1. Persists canonical users in `lp_users` table (shared `lp_` prefix with persist-postgres)
2. Maps channel-specific peer IDs to canonical users via `lp_user_channels`
3. Verifies identity via JWT (HS256) or external endpoint when user provides `/verify <token>`
4. Falls back to channel-only identity via `/register <first> <last>` for users without tokens
5. Injects `[USER_IDENTITY]` block into `prependContext` for every agent invocation

**Layer 2: `auth-memory-gate` (future)**

A memory scoping plugin that:

1. Reads the canonical `user_id` from Layer 1's DB or `[USER_IDENTITY]` context
2. Configures downstream memory frameworks (Graphiti `group_id`, LanceDB filter, pgvector WHERE clause)
3. Gates memory retrieval behind verified identity status

This split aligns with OpenClaw's plugin philosophy: composable, single-responsibility, no core changes.

## Key Hypothesis

We believe that a JWT-verified identity layer in front of memory retrieval will enable developers to safely share user context across SMS, WhatsApp, and chat API channels.
We'll know we're right when a single user authenticated across 3 channels sees consistent, scoped memory recall in each conversation without memory leakage to other users.

## What We're NOT Building

- **A user management system** — the developer's app owns user accounts, JWT issuance, and user profile storage
- **An identity provider (IdP)** — we assume JWTs are already being issued by the developer's app
- **A new memory backend** — this gates access to existing/future memory plugins (Graphiti, LanceDB, etc.)
- **Channel-specific auth flows** — the auth token is a single JWT that works identically regardless of channel
- **Automatic identity discovery** — cross-channel linking requires explicit configuration via `identityLinks` or user-initiated token verification

## Success Metrics

| Metric                          | Target                                              | How Measured                                                                 |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cross-channel memory continuity | Same user on 3 channels sees same recalled memories | E2E test: send facts via WhatsApp, verify recall via chat API                |
| Memory isolation                | Zero cross-user memory leakage                      | E2E test: User A's memories never appear in User B's context                 |
| Auth gate enforcement           | 100% of memory retrievals require verified identity | Unit test: `before_agent_start` hook blocks recall when no valid JWT present |
| Token verification latency      | < 50ms per request (cached JWKS)                    | Benchmark: measure JWT verification in hot path                              |

## Open Questions

- [ ] How should the user present their JWT via non-web channels (SMS/WhatsApp)? Options: (a) one-time passcode exchange via channel, (b) pre-configured `identityLinks` mapping, (c) magic link sent to phone
- [ ] Should token refresh be handled by the plugin or deferred to the developer's app?
- [ ] How does Graphiti's `group_id` parameter work exactly — is it a partition key, a filter, or a namespace? Need to validate against Graphiti SDK
- [ ] Should identity resolution be stateless (derive from sessionKey + identityLinks every time) or stateful (persist resolved identity in a store)?
- [ ] Rate limiting / abuse prevention for token verification attempts?

---

## Users & Context

**Primary User**

- **Who**: Developer self-hosting OpenClaw as the AI backend for a multi-channel application (e.g., longevity clinic with patient-facing web app + SMS/WhatsApp outreach)
- **Current behavior**: Deploys separate agents per channel or accepts that memory is shared/unsegmented. Manually configures `identityLinks` for session routing but gets no memory scoping benefit.
- **Trigger**: Needs to launch a production app where patients interact via web chat AND receive WhatsApp follow-ups, and the agent must remember patient context across both — without leaking to other patients.
- **Success state**: Configure one plugin, set a JWKS URL, map channel identities, and memory is automatically scoped per-patient across all channels.

**Job to Be Done**
When a developer connects multiple communication channels to OpenClaw, they want to ensure the agent recalls user-specific context regardless of which channel the user is on, so they can deliver a personalized, continuous experience without building custom memory isolation logic.

**Non-Users**

- Single-channel deployments with no cross-channel identity needs
- Developers who want OpenClaw to BE the identity provider (we delegate this to their app)
- Use cases requiring real-time memory sync across agents (this is per-agent scoping)

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability                                                                                                                                 | Rationale                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Must     | **JWT verification** — validate tokens via JWKS URL or shared HS256 secret                                                                 | Core auth gate; without this, no identity verification                    |
| Must     | **Canonical identity resolution** — map channel peer IDs to canonical userId via identityLinks + JWT `sub` claim                           | Required to unify cross-channel sessions                                  |
| Must     | **Memory scoping hook** — `before_agent_start` injects scoped context (e.g., `group_id` for Graphiti) based on verified identity           | The core value prop: only retrieve this user's memories                   |
| Must     | **Chat API auth enforcement** — `/chat` requests must include Bearer token; reject unauthenticated requests                                | Web channel is the primary entry point for authenticated users            |
| Should   | **Token-to-identity binding via channel** — user presents JWT once per channel session, identity is cached for session duration            | Reduces friction on channels where pasting tokens is awkward              |
| Should   | **Memory write scoping** — `agent_end` hook tags stored memories with canonical userId                                                     | Ensures new memories are stored with correct ownership                    |
| Could    | **Passcode-based channel linking** — user sends a short-lived passcode via SMS/WhatsApp to link that channel identity to their app account | Improves UX for non-web channels                                          |
| Won't    | **User profile storage** — plugin does not store user profiles, only identity mappings                                                     | Developer's app owns user data                                            |
| Won't    | **Multi-tenant workspace isolation** — this scopes within a single workspace, not across workspaces                                        | Different problem; use separate OpenClaw instances for true multi-tenancy |

### MVP Scope

1. Plugin `extensions/auth-memory-gate/` with:
   - JWT verification (JWKS + HS256 fallback)
   - `before_agent_start` hook that resolves canonical identity from `sessionKey` + `identityLinks` config
   - Exposes `resolvedUserId` to downstream memory plugins via `prependContext` system prompt injection AND a new `api.setSessionMeta()` pattern
   - `message_sending` hook that gates replies when identity is unverified on `/chat` channel
2. Config schema:
   ```yaml
   plugins:
     auth-memory-gate:
       jwksUrl: "https://myapp.com/.well-known/jwks.json"
       # OR
       jwtSecret: "hs256-shared-secret"
       issuer: "https://myapp.com"
       audience: "openclaw-agent"
       requiredChannels: ["chat"] # Channels requiring JWT auth
       optionalChannels: ["whatsapp", "sms"] # Channels using identityLinks
       memoryScoping:
         parameter: "group_id" # Maps to Graphiti's group_id
         claim: "sub" # JWT claim to use as the scoping value
   ```

### User Flow

**Web Chat (authenticated):**

```
User → App login → App issues JWT → User opens chat widget →
  Chat widget sends JWT as Bearer token with first message →
    auth-memory-gate validates JWT → extracts `sub` claim →
      resolves canonical userId → passes group_id to memory plugin →
        Agent recalls user-specific memories → responds with context
```

**WhatsApp (identity-linked):**

```
User registered in app with phone +1234567890 →
  Developer configures identityLinks: { "user-abc": ["+1234567890", "chat:user-abc"] } →
    User messages via WhatsApp → sessionKey includes phone number →
      auth-memory-gate resolves phone → canonical "user-abc" via identityLinks →
        passes group_id="user-abc" to memory plugin → Agent recalls user memories
```

**WhatsApp (passcode linking — Phase 2):**

```
User messages agent on WhatsApp → Agent: "Please enter your verification code" →
  User gets code from web app → pastes in WhatsApp →
    auth-memory-gate validates code → creates identityLink mapping →
      subsequent messages auto-resolve identity
```

---

## Technical Approach

**Feasibility**: HIGH

This composes entirely from existing primitives:

- `identityLinks` for cross-channel identity resolution (already in `session-key.ts`)
- Plugin `before_agent_start` hook for injecting scoped context (same pattern as memory-lancedb)
- Plugin `message_sending` hook for gating unauthenticated replies (same pattern as thread-ownership)
- `pluginConfig` for receiving validated configuration
- Standard `jose` library for JWT/JWKS verification (battle-tested, zero native deps)

**Architecture Notes**

- JWT verification uses `jose` library (JWKS auto-caching with 10min TTL)
- Identity resolution is stateless: parse `sessionKey` → check `identityLinks` → check JWT cache → resolve
- Memory scoping is injected via `prependContext` (e.g., `"[MEMORY_SCOPE:group_id=user-abc]"`) which downstream memory plugins read
- For Graphiti specifically: the plugin sets an environment-like context that the Graphiti plugin reads when constructing queries
- Token cache: in-memory Map keyed by sessionKey, with TTL matching JWT `exp`

**Technical Risks**

| Risk                                                        | Likelihood | Mitigation                                                                                    |
| ----------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| JWT verification on every `before_agent_start` adds latency | LOW        | Cache verified tokens per sessionKey; JWKS cached with 10min TTL                              |
| `identityLinks` config becomes stale as users are added     | MEDIUM     | Phase 2: Dynamic identity linking via passcode verification                                   |
| Memory plugins ignore scoping context                       | MEDIUM     | Define a convention (`MEMORY_SCOPE` prefix in prependContext) + document integration contract |
| JWKS endpoint unavailable                                   | LOW        | Fallback to HS256 if configured; cache last-known-good JWKS for 1hr                           |
| Channel-specific session key format changes                 | LOW        | Use `resolveLinkedPeerId()` from session-key.ts rather than manual parsing                    |

---

## Implementation Phases (Revised)

### Layer 1: `persist-user-identity` (this PR)

| #   | Phase                       | Description                                                                    | Status       | Depends |
| --- | --------------------------- | ------------------------------------------------------------------------------ | ------------ | ------- |
| 1a  | DB Schema + Plugin Scaffold | `lp_users`, `lp_user_channels` tables, package.json, manifest                  | **complete** | -       |
| 1b  | Identity Resolution Hook    | `before_agent_start` at priority 60, injects `[USER_IDENTITY]` block           | **complete** | 1a      |
| 1c  | User Commands               | `/verify <token>`, `/register <first> <last>`, `/whoami` via `registerCommand` | **complete** | 1a      |
| 1d  | JWT Verification            | HS256 (built-in crypto, zero deps) + verify-endpoint fallback                  | **complete** | -       |
| 1e  | Identity Contract Docs      | `IDENTITY_CONTRACT.md` — how downstream plugins consume identity               | **complete** | 1b      |

### Layer 2: `auth-memory-gate` (future PR)

| #   | Phase                 | Description                                                                      | Status       | Depends | PRP Plan                                                        |
| --- | --------------------- | -------------------------------------------------------------------------------- | ------------ | ------- | --------------------------------------------------------------- |
| 2a  | Memory Scoping Hook   | Read identity from Layer 1 DB, inject `group_id` for Graphiti/LanceDB/pgvector   | **complete** | Layer 1 | `.claude/PRPs/plans/auth-memory-gate.plan.md`                   |
| 2a+ | Hard Identity Gate    | message_sending hook + strengthened before_agent_start for hard gate enforcement | **complete** | 2a      | `.claude/PRPs/plans/completed/auth-gate-railway-rebase.plan.md` |
| 2b  | Chat API Bearer Token | Extract JWT from `/chat` Bearer header, auto-verify on connect                   | pending      | Layer 1 | -                                                               |
| 2c  | Memory Write Tagging  | `agent_end` hook tags stored memories with canonical `user_id`                   | pending      | 2a      | -                                                               |
| 2d  | Integration Tests     | E2E: cross-channel recall, isolation, auth rejection                             | complete     | 2a      | `.claude/PRPs/plans/identity-scoped-memory-e2e.plan.md`         |

### Key Design Decisions (Revised)

| Decision          | Choice                                                        | Why Changed                                                                                                                          |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| JWT library       | Node built-in `crypto` (HS256)                                | Zero deps. `jose` deferred to Layer 2 if JWKS needed.                                                                                |
| Identity storage  | PostgreSQL `lp_users` + `lp_user_channels`                    | Aligns with persist-postgres patterns. DB-backed > config-based for dynamic linking.                                                 |
| Command interface | `api.registerCommand()` for `/verify`, `/register`, `/whoami` | First-class plugin API. Processes before agent, has `senderId`/`channel` context, returns direct reply. Cleaner than prompt parsing. |
| Auth enforcement  | Commands are `requireAuth: false`                             | Any channel user can self-identify. Authorization of what they can ACCESS is Layer 2's concern.                                      |
| Fallback identity | Channel-only via `/register`                                  | User can opt out of token verification. Channel peer ID becomes their identity. Upgradable later via `/verify`.                      |

---

## Decisions Log

| Decision                   | Choice                                                  | Alternatives                                                                              | Rationale                                                                                                        |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| JWT library                | `jose` (universal JS)                                   | `jsonwebtoken` (Node-only), manual verification                                           | `jose` is ESM-native, supports JWKS auto-discovery, no native deps, used in modern auth stacks                   |
| Identity resolution        | Stateless (sessionKey + identityLinks + JWT cache)      | Stateful (persist identity mappings in DB)                                                | Simpler, no new storage dependency, sufficient for MVP. Phase 2 adds stateful passcode linking.                  |
| Memory scoping mechanism   | `prependContext` with convention prefix                 | New hook type, shared state, environment variable                                         | Composes with existing hook system. No core changes needed. Memory plugins opt-in by reading the convention.     |
| Auth enforcement point     | `message_sending` hook (cancel unauthenticated replies) | `message_received` (can't block, void return), gateway middleware (requires core changes) | `message_sending` can return `{ cancel: true }` — only hook that can gate outbound messages without core changes |
| Cross-channel linking      | Leverage existing `identityLinks` config                | New identity service, database-backed mapping                                             | Reuses proven primitive. Developer already configures agents in YAML — adding identity mappings is natural.      |
| Token presentation for web | Bearer token in chat API request                        | Cookie, query param, custom header                                                        | Standard OAuth2 pattern. Chat API already supports auth headers via gateway connect params.                      |

---

## Research Summary

**Market Context**

- Multi-channel AI agents (Voiceflow, Botpress, Rasa) all face this problem but solve it with centralized user databases — OpenClaw's decentralized, config-driven approach is unique
- JWT-gated memory is common in RAG systems (Pinecone namespaces, Weaviate tenants) but not yet standard in agent frameworks
- Graphiti uses `group_id` as a namespace/partition key for episodic memory scoping

**Technical Context**

- `identityLinks` (`session-key.ts:190-234`) resolves cross-channel identities to canonical names — production-ready for DM scoping
- `before_agent_start` hook (`plugins/types.ts:355-359`) returns `{ prependContext, systemPrompt }` — the injection point for scoped memory
- `message_sending` hook can return `{ cancel: true }` — the gate point for blocking unauthenticated replies
- `persist-postgres` (`extensions/persist-postgres/`) demonstrates the scoped-storage plugin pattern
- Plugin config via `api.pluginConfig` + `configSchema` in manifest — standard config delivery mechanism
- OAuth extensions (google-gemini-cli-auth, minimax-portal-auth) show provider registration patterns but are model-facing, not user-facing
- Session key format `agent:{agentId}:{channel}:{userId}` embeds channel-specific identity that can be parsed for resolution

---

_Generated: 2026-02-24_
_Status: DRAFT — needs validation of Graphiti group_id behavior and channel-specific token presentation UX_
