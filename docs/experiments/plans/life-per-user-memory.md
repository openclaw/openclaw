# Per-User Memory for the **"life"** Agent — Architecture Plan

**Status:** Reviewed (codex, commit `4656892f0`) — revised, **ready to execute**.
**Scope:** The `life` agent (Havaya.me) OpenClaw gateway **only** — not a system-wide / multi-agent change.
**Author:** handover session, 2026-06-03
**Predecessor:** the existing Havaya per-user "user-file" section mechanism (`save_user_section` tool, app-key auth, lowercased-userId filename, `life` on the US host).

---

## 0. Revision 2 — synced with codex review (2026-06-04)

Codex verdict (see `life-per-user-memory-architecture-review.md`, same branch): **conditional
go — directionally sound**, but the scoping proxy must become a strict **capability boundary**
and per-session identity handoff must be made concrete. This section folds in every codex note
plus decisions locked with the owner. **It supersedes any conflicting detail in §1–§10 below.**

**Owner decisions locked:**

- "Show me my file" is an **agent-level capability keyed by the canonical userId** — the
  channel (Telegram/app) is just transport. Generalize the current app-only `save_user_section`
  path to serve **both** channels off the canonical userId.
- **Raw writes every turn** (accepted risk: raw episode text reaches the embeddings/LLM
  provider; mitigate via provider choice + erasure, not redaction, in v1).
- **No backfill** — start fresh; owner seeds user-files manually post-setup (seed list below).

**Codex deltas applied:**

1. **Identity (§3 / Phase 0) — revise.** Telegram per-user key = **`tg:<from.id>`** (the human
   sender), **not `chat_id`**. Telegram **group-conversation** memory is a **v1 non-goal**
   (reserve `tg-group:<chat.id>`). App key = **`app:<appUserId>`**. Same human across tg/app =
   two scopes in v1 (explicit server-side linking deferred; blast radius is fragmented memory,
   not leakage).

2. **Scoping proxy (§4 / Phase 2) — BLOCK / security-critical.** Reframe "thin wrapper" →
   **allowlist proxy / capability boundary**:
   - Expose ONLY (v1): `add_memory` (group_id forced to current user), `search_nodes` and
     `search_memory_facts` (group_ids forced to `[currentGroupId]`), optionally `get_episodes`
     (same forcing).
   - HIDE from the model: `get_entity_edge(uuid)`, `delete_entity_edge(uuid)`,
     `delete_episode(uuid)`, `clear_graph(group_ids)`, `get_status()`, and all UUID/maintenance/
     raw graph ops.
   - **Strip `center_node_uuid`** in v1 (foreign-UUID ranking/error side channel); re-allow only
     if verified to belong to `currentGroupId`.
   - **Erasure = admin-only**, never model-exposed.
   - **Per-session identity handoff — pick ONE and document it** (do _not_ rely on a static
     agent-level env var): (a) proxy resolves group_id server-side from a signed per-session
     token _(preferred)_, (b) bridge injects session context on every tool call, or (c) per-run
     MCP process per session with a scoped env var. **First task: determine how mcp-bridge
     actually passes session identity** (read `docs/gateway/bridge-protocol.md` + source), then choose.

3. **User-file = visible artifact (§7 / Phase 5) — revise.** Keep the per-user **user-file** as
   the human-readable "your file" surface; **Graphiti is recall/index only**, never the source
   for "show me my file". **Generalize `save_user_section`** from `appUserId`-only to the
   canonical userId so it serves both channels. Graphiti may optionally write summaries _into_
   the user-file via an explicit scoped tool.

4. **Deploy / wire (§8 / Phase 1+3) — clarify.** FalkorDB + Graphiti + allowlist proxy as a
   small agent-local Docker Compose stack on US host `5.161.84.219` (~1 GB). Phase 3 = **create
   OR update** `/root/.openclaw/agents/life/openclaw.json` (a missing file is expected for a
   planned agent); use **kycbot's `mcp-bridge` block** as the template.

5. **Recall/write loop (Phase 4).** Read-before-answer (`search_memory_facts`/`search_nodes`),
   **write-after-turn raw** (`add_memory`) every turn (owner decision).

6. **Tests (Phase 6) — revise.** Add **adversarial proxy-level** tests, not just happy-path:
   cross-`group_id` read returns nothing; UUID/delete/clear/status tools are not callable;
   `center_node_uuid` injection is stripped; per-channel recall works (`from.id` and `appUserId`).

**Recommended seed content** (owner adds user-files manually post-setup), per user:
identity basics (name, pronouns, timezone/locale, language); communication preferences
(tone, length, do/don't, hard boundaries); goals & active projects; key people/relationships;
recurring context (routines, important dates; health/dietary only if consented); constraints
the agent must always respect; and a **"never store" note** (credentials/secrets) at the top.

**Still-open (carried into execution):** exact mcp-bridge session-identity mechanism (drives
Phase 2); embeddings/LLM provider; multi-store **erasure contract** (Graphiti + user-file +
transcripts + logs + provider traces); confirm final tool allowlist and `center_node_uuid`
disabled in v1.

**Phase verdicts (codex):** Phase 1 Sound · Phases 0, 2, 3, 5, 6 Needs-revision (applied above)
· Phase 4 Sound-with-guardrails.

---

## 1. Goal

Give the `life` agent **durable, per-user memory** of past conversations so that every interaction — whether it arrives from **Telegram** or from a **Havaya app user** — is grounded in that specific user's history, and **no user can ever read another user's memory**.

Concretely:

1. Memory is **per user**, isolated.
2. The **same memory store backs all interactions** for that user, regardless of channel (Telegram _or_ app).
3. When a user asks to "see my workspace / my files," the agent returns **only that user's own file** — never a listing of the workspace or anyone else's data.

This plan is **Graphiti-based**, using the open-source code from **https://github.com/getzep/graphiti** (the `mcp_server/` component), self-hosted next to the `life` gateway.

> **Note on the original brief:** the first draft proposed AppFlowy. That is dropped — AppFlowy is an 11-service collaboration suite with no service-account model and no programmatic per-user document isolation (isolation is workspace-level, document ACLs have no public API). It is the wrong tool for programmatic agent memory. Graphiti is purpose-built for exactly this.

---

## 2. Non-goals

- Not changing any other agent (testingbot, kycbot, mystory, etc.). `life` only.
- Not building a human-facing document editor / UI.
- Not a system-wide MCP rollout — the Graphiti server is registered in **`life`'s** `openclaw.json` only.
- Not removing the existing per-user user-file endpoint on day one (see §7 — it stays as the human-readable "this is your file" surface).

---

## 3. Identity model — the crux of "App users _and_ Telegram users"

Memory isolation is only as good as the **user key** used to scope it. Both channels must resolve to **one canonical user key**, which becomes the Graphiti `group_id`.

| Channel        | Raw identifier available at the gateway                              | Canonical key     |
| -------------- | -------------------------------------------------------------------- | ----------------- |
| Telegram       | `chat_id` / Telegram user id (e.g. `344061779`)                      | `tg:344061779`    |
| Havaya **app** | `appUserId` (already rides the session entry via `loadSessionEntry`) | `app:<appUserId>` |

**Rules:**

- The **gateway** resolves the canonical key from the inbound session entry / message metadata. The model never invents it.
- `group_id` is **namespaced by channel** (`tg:` / `app:`) so the two id-spaces can't collide.
- **Identity linking is a future option, not v1:** if a human is both a Telegram user _and_ an app user, v1 keeps them as two separate memory scopes. A later phase can add an explicit `link(appUserId ↔ telegramId)` mapping that points both keys at one canonical `group_id`. v1 must not block this (keep the mapping in one place — see §4 scoping proxy).

This directly satisfies feedback point #2 (app users considered alongside Telegram) and #5 (one memory store serves _all_ interactions for a user).

---

## 4. Architecture

```
            Telegram user                 Havaya app user
                 │  chat_id                     │  appUserId
                 ▼                              ▼
        ┌──────────────────────────────────────────────┐
        │     life  OpenClaw gateway (US host)          │
        │                                                │
        │  1. resolve canonical userId from session      │
        │     entry  →  group_id = "tg:…" | "app:…"      │
        │  2. inject group_id into the session context   │
        └───────────────┬────────────────────────────────┘
                        │ mcp-bridge spawns
                        ▼
        ┌──────────────────────────────────────────────┐
        │   Graphiti MCP  +  scoping proxy (the key)     │
        │                                                │
        │  • group_id is PINNED server-side from the     │
        │    gateway-provided identity, NOT chosen by    │
        │    the model                                   │
        │  • add_episode / search_* are rewritten to     │
        │    force the caller's group_id                 │
        │  • list/aggregate across groups is DISABLED    │
        └───────────────┬────────────────────────────────┘
                        │ HTTP/Bolt
                        ▼
        ┌──────────────────────────────────────────────┐
        │   Graphiti core  +  graph DB (FalkorDB or      │
        │   Neo4j) — temporal knowledge graph,           │
        │   one group_id namespace per user              │
        └──────────────────────────────────────────────┘
```

### Components (all from / around `getzep/graphiti`)

1. **Graphiti core + graph DB.** Run the Graphiti service with **FalkorDB** (Redis-based, no license) — lighter than Neo4j and sufficient. One Docker Compose stack on the **US host** (where `life` already runs). Per-user data lives under distinct `group_id` namespaces.

2. **Graphiti MCP server** (`getzep/graphiti` → `mcp_server/`). Exposes `add_episode`, `search_nodes`, `search_facts`, `get_episodes`, etc. Each takes a `group_id`.

3. **Scoping proxy (the isolation guarantee).** A thin wrapper that sits between mcp-bridge and the Graphiti MCP server. It **hard-binds `group_id`** to the gateway-resolved identity for the current session and **strips/overrides** any `group_id` the model tries to pass. It also **refuses any cross-group or "list all" operation.** This is what makes points #1, #6 enforceable rather than merely "the prompt asks nicely."

### Wiring into `life` (per feedback #1 — this agent only)

- Add a `graphiti` entry under `plugins.entries.mcp-bridge.config.servers` in **`life`'s `openclaw.json`** (same shape as `kycbot`'s `exa` / `panadata` entries), pointing at the scoping-proxy command. No other agent's config is touched.
- The gateway passes the resolved `group_id` to the proxy per session (env/handshake), so the model's tool calls are scoped without the model being trusted to scope them.

---

## 5. Per-user isolation & "only show the user their own file" (feedback #6)

Two layers, defense-in-depth:

1. **Hard scoping (primary).** The scoping proxy pins `group_id`. A Graphiti query with the caller's `group_id` _cannot_ return another user's nodes/facts — isolation is enforced at the graph query layer, not by prompt discipline. "List all files / show the workspace" maps to **"return only this `group_id`'s contents."** There is no API path from a user session to another user's namespace.

2. **Prompt/tool contract (secondary).** The `life` system prompt states: the agent has memory of _this_ user only; when asked to show "my file / my workspace," it returns the current user's memory export and nothing else; it must never attempt to read another user's memory.

Result: even a jailbroken/confused model cannot exfiltrate another user's memory, because the proxy never forwards a foreign `group_id`.

---

## 6. Data flow (both channels, feedback #5)

Every inbound turn, for both Telegram and app users:

1. Gateway resolves `group_id` from the session entry.
2. **Read:** before answering, agent calls `search_facts` / `search_nodes` (proxy-scoped) to recall relevant prior context for this user.
3. **Answer:** model responds using recalled memory.
4. **Write:** after the turn, agent calls `add_episode` (proxy-scoped) to persist the new exchange. Graphiti's temporal model captures _how facts change over time_ (e.g. the user's situation evolving) — valuable for a "life" assistant.

The same store, same `group_id`, regardless of whether the turn came from Telegram or the app.

---

## 7. Relationship to the existing per-user user-file API

The current mechanism (Havaya per-user section, `save_user_section`, app-key auth, raw lowercased-userId filename) is the **predecessor** of this work. Proposed coexistence:

- **Graphiti = the agent's working memory** (recall + temporal facts; queried/written automatically every turn).
- **The user-file = the human-readable "your file"** surface — the thing a user sees when they ask "show me my file." Keep it as a curated export/summary derived from (or written alongside) the Graphiti memory.
- This keeps feedback #6 honest: "show me my file" returns the user-file for **that** `appUserId`/`telegramId`, which already enforces single-user scoping via app-key auth + per-user filename.

**Decision needed (for review):** does Graphiti _replace_ the user-file as the source of truth, or does the user-file remain the canonical export with Graphiti as an enrichment layer? Recommended: **user-file stays as the visible artifact; Graphiti is the recall engine.** Both keyed by the same canonical user id.

---

## 8. Deployment (US host, where `life` lives)

- New Docker Compose stack on `root@5.161.84.219`: `falkordb` + `graphiti` + `graphiti-mcp`(scoping proxy). ~1 GB RAM.
- Wire `life`'s `openclaw.json` mcp-bridge entry to the proxy.
- Follow existing ops conventions — **no ad-hoc docker commands**; add to the ops scripts pattern if a deploy script is warranted.
- Smoke test: send a fact via Telegram → new session → confirm recall; repeat for an app user; confirm cross-user isolation by attempting (and failing) to read another `group_id`.

---

## 9. Open questions for review

1. **Graph DB choice:** FalkorDB (lighter, recommended) vs Neo4j (more tooling).
2. **Embeddings/LLM for Graphiti:** which provider for entity extraction + embeddings (affects cost & where keys live). Reuse the agent's existing model provider, or a dedicated cheap embeddings model?
3. **Source of truth:** Graphiti vs user-file (see §7) — recommend user-file stays visible, Graphiti is recall.
4. **Identity linking:** v1 keeps `tg:` and `app:` separate; confirm that's acceptable for launch.
5. **Retention/erasure:** per-user delete (GDPR-style "forget me") = drop the `group_id` namespace. Confirm we want this exposed.

---

## 10. Implementation phases (no code in this doc — plan only)

- **Phase 0 — Identity:** confirm gateway can resolve a stable canonical `group_id` for both Telegram and app sessions from the session entry.
- **Phase 1 — Deploy Graphiti:** FalkorDB + Graphiti + MCP server on the US host (Compose).
- **Phase 2 — Scoping proxy:** hard-pin `group_id`, disable cross-group ops. This is the security-critical piece — review carefully.
- **Phase 3 — Wire `life`:** add the mcp-bridge server entry to `life`'s `openclaw.json`; system-prompt memory instructions.
- **Phase 4 — Recall/write loop:** agent reads before answering, writes after.
- **Phase 5 — User-file integration:** "show my file" returns the per-user export only (§7).
- **Phase 6 — Smoke + isolation tests:** verify recall per channel and cross-user isolation.
