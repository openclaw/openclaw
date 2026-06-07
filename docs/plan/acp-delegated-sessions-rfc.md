---
title: "RFC: Hub-delegated persistent ACP sessions"
summary: "Parent-owned persistent ACP workers from hub sessions without channel thread binding, with follow-up via sessions_send(label=...) and operator lifecycle via /acp delegate"
read_when:
  - You want persistent ACP workers from WebChat, Feishu, or other non-thread channels
  - You are designing hub-and-spoke orchestration with sessions_send instead of A2A ping-pong
  - You are evaluating delegate parameters on sessions_spawn
status: implemented
---

## Status

| Field            | Value                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **State**        | Implemented on `feat/acp-hub-delegated-sessions`                                                                                             |
| **Author**       | @scotthuang                                                                                                                                  |
| **Created**      | 2026-06-05                                                                                                                                   |
| **Shipped docs** | [ACP agents — Hub-delegated persistent workers](/tools/acp-agents#hub-delegated-persistent-workers), [Session tools](/concepts/session-tool) |
| **Reviewers**    | ACP/acpx owners, session-tools owners                                                                                                        |

## Summary

Hub-delegated ACP sessions are **parent-owned persistent harness workers** spawned from a hub session (WebChat, WeChat, Feishu DM, etc.) **without** channel thread binding:

- Spawn: `sessions_spawn({ runtime: "acp", delegate: true, label?, task, agentId? })`
- Follow-up: `sessions_send({ label, message })` from the owning hub session
- Discovery: `sessions_list({ delegated: true })`
- Operator lifecycle: `/acp delegate list|status|close <label>`
- Maintenance: idle/max-age sweeps via `acp.delegate.*`

OpenClaw **skips A2A ping-pong/announce** for hub-owner → own-delegate `sessions_send` because the parent already owns the visible completion path.

> **Naming note:** Unrelated to [Delegate architecture](/concepts/delegate-architecture) (organizational named agents). Prose uses **hub-delegated ACP session**; the spawn parameter is **`delegate`**.

## Motivation

### Problem

Persistent ACP orchestration previously had two awkward paths:

1. **Thread-bound `mode: "session"`** — requires a channel with thread/topic bindings. Many hub surfaces cannot satisfy this.
2. **Interactive `/acp spawn` + peer `sessions_send`** — works without threads, but peer sends can run the full **A2A** follow-up loop (wait, bounded ping-pong, announce), which is heavy for simple hub relay.

`sessions_spawn(runtime: "acp", mode: "session")` required **`thread: true`**. There was no supported way to create a **persistent parent-owned** ACP worker from a hub without a thread.

### User story

As an operator on WebChat or Feishu DM:

1. Main agent spawns a long-lived Codex/Claude Code ACP worker for a repo task.
2. Main agent lists active delegated workers (`sessions_list({ delegated: true })`).
3. Main agent sends follow-ups via `sessions_send(label=...)` without opening a Discord thread or switching UI sessions.
4. Delegated worker output returns inline to the hub turn (no duplicate announce ping-pong).
5. Operator inspects or closes workers with `/acp delegate list|status|close <label>` when done.

## Goals (delivered)

- Persistent ACP sessions from hub sessions **without** `thread: true`.
- Reuse **parent-owned background** semantics (`spawnedBy` / `parentSessionKey` / `hubDelegated.ownerSessionKey`).
- **`sessions_send`** as canonical follow-up; **skip A2A** for owner → own-delegate sends.
- **Label-based routing** with **owner-scoped uniqueness** (spawn pre-check and `sessions.patch` aligned).
- **Discoverability** for agents (`sessions_list`) and operators (`/acp delegate`).
- **Session-store-backed** ownership and lifecycle (JSON store marker + sqlite ACP meta); no parallel routing table.
- **Maintenance** idle/max-age auto-close with JSON-store sweep for store-only delegates.

## Non-goals

- Replacing `/acp spawn --bind here` for channels that support current-conversation binding.
- Replacing thread-bound persistent ACP for channels that want human-visible child threads.
- New cross-session transport besides existing `sessions_send` / gateway `agent` dispatch.
- Organizational "delegate agent" identity model changes.
- Automatic multi-hub fan-out or pub/sub between unrelated sessions.
- Sandbox/host ACP policy changes (delegated spawn remains host-side; sandboxed requesters stay blocked).
- Agent-tool `sessions_close` for hub-delegated workers (close is operator-facing by design; see Lifecycle).

## Background (current behavior)

| Path                                     | Persistent   | Parent-owned | Thread required   | Follow-up comms                            | A2A on hub send      |
| ---------------------------------------- | ------------ | ------------ | ----------------- | ------------------------------------------ | -------------------- |
| `/acp spawn` (unbound)                   | yes          | no           | no                | user channel or `sessions_send`            | yes (peer)           |
| `/acp spawn --bind here`                 | yes          | no           | no (bind instead) | bound conversation                         | n/a                  |
| `sessions_spawn(acp, mode=run)`          | no (oneshot) | yes          | no                | task completion + optional `sessions_send` | skipped (parent)     |
| `sessions_spawn(acp, mode=session)`      | yes          | yes          | **yes**           | bound thread                               | n/a                  |
| **`sessions_spawn(acp, delegate=true)`** | **yes**      | **yes**      | **no**            | **`sessions_send(label=...)`**             | **skipped (parent)** |

Relevant code/doc anchors:

- Spawn + delegate gate: `src/agents/acp-spawn.ts`
- Metadata + policy: `packages/acp-core/src/hub-delegated.ts`
- Parent-owned classification: `packages/acp-core/src/session-interaction-mode.ts`
- Follow-up + label resolve: `src/agents/tools/sessions-send-tool.ts`
- Operator commands: `src/auto-reply/reply/commands-acp/delegate.ts`
- Maintenance + close ordering: `src/acp/hub-delegated-lifecycle.ts`
- User docs: [ACP agents](/tools/acp-agents#hub-delegated-persistent-workers)

## Delivered design

### 1. Spawn API

```json5
{
  runtime: "acp",
  delegate: true,
  agentId: "codex",
  label: "repo-fix", // optional; auto-generated UTC label when omitted
  task: "Fix the failing tests in src/foo and summarize what changed.",
  cwd: "/path/to/repo",
}
```

**Rules:**

| Rule                             | Behavior                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate: true`                 | Only valid with `runtime: "acp"`                                                                                                                      |
| `mode`                           | Implied persistent (`"session"`). `"run"` rejected                                                                                                    |
| `thread: true`                   | Rejected (`delegate_thread_conflict`)                                                                                                                 |
| `streamTo: "parent"`             | Allowed; orthogonal to delegate persistence                                                                                                           |
| `label`                          | Optional. When omitted, auto-label `delegate-YYYYMMDD-HHMMSS` (UTC). Explicit labels unique among **active hub-delegated workers for the same owner** |
| `spawnedBy` / `parentSessionKey` | Set to requester internal session key                                                                                                                 |
| `hubDelegated`                   | `{ ownerSessionKey, createdAt }` persisted on session entry                                                                                           |

### 2. Session metadata (canonical store)

Shipped marker on the JSON session entry (no separate routing file):

```ts
type HubDelegatedSessionMeta = {
  ownerSessionKey: string;
  createdAt: number;
};

// SessionEntry additions used at runtime:
// - hubDelegated?: HubDelegatedSessionMeta
// - label?: string
// - spawnedBy / parentSessionKey (existing ACP spawn lineage)
// - acp sqlite metadata via standard ACP session meta
```

Listing, authorization, maintenance, and operator commands filter store rows by `hubDelegated.ownerSessionKey` (and owner-scoped `label` for follow-up/close).

### 3. Communication model

**Follow-ups** from the owning hub session:

```json5
{
  label: "repo-fix",
  message: "Also add a regression test for the edge case we discussed.",
  timeoutSeconds: 300,
}
```

**Delivery:**

- Gateway `agent` dispatch into the delegate session.
- Owner → own-delegate: **`skipA2AFlow`** (`delivery.status: "skipped"`).
- Inline reply in `sessions_send` result when `timeoutSeconds > 0`.
- Label resolve: owner-scoped for hub-delegated targets; normal visible sessions keep existing `tools.sessions.visibility` behavior.

**Non-behavior:** delegated workers do not auto-announce into the hub visible channel on every turn. Hub relay stays tool-driven.

### 4. Discovery surfaces

#### Agent tools

- `sessions_list({ delegated: true })` — owned hub-delegated rows
- `sessions_send({ label, message })` — follow-up by label
- `sessions_spawn({ runtime: "acp", delegate: true, ... })` — create worker

#### Operator commands (shipped)

```text
/acp delegate list
/acp delegate status <label>
/acp delegate close <label>
```

Implementation uses JSON store sweep (same discovery source as maintenance), enriched with sqlite ACP meta when present. Store-only delegates (JSON marker, missing sqlite) remain visible to operators and maintenance.

### 5. Lifecycle

| Event                  | Behavior                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Create                 | `delegate: true` spawn patches session entry, initializes persistent ACP runtime, runs initial `task`, keeps session open |
| Follow-up              | `sessions_send` queues a new turn in the delegate session                                                                 |
| Idle / max age         | `acp.delegate.idleHours` (default `72`) and `acp.delegate.maxAgeHours` (default `168`); `0` disables either limit         |
| Owner / operator close | `/acp delegate close <label>` clears `hubDelegated`, closes runtime when sqlite meta exists, unbinds                      |
| Maintenance expiry     | Same close path via `closeHubDelegatedAcpWorker()`; JSON-store sweep includes store-only delegates                        |
| Failed close           | `hubDelegated` marker restored on runtime close failure so retry paths remain discoverable                                |
| Hub session reset      | Delegates survive hub `/new` unless explicitly closed (unchanged; no auto-close on hub reset in this delivery)            |

**Close model:** Hub agents create and follow up by label. **Operators** tear down persistent harness sessions via `/acp delegate close` (and maintenance). Thread-bound ACP sessions continue to use `/acp close`.

### 6. Authorization and visibility

- **Send/list/history:** delegate owner (`hubDelegated.ownerSessionKey` / `spawnedBy` / `parentSessionKey`) OR existing session tool visibility + `tools.agentToAgent` policy.
- **`visibility: tree` / `all`:** unrelated sessions do not get owner-only skip-A2A; they use normal A2A when policy allows.
- **Sandboxed hub:** spawn remains blocked (unchanged ACP host policy).

## Alternatives considered

| Alternative                                           | Why not                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Separate in-memory routing table                      | Drifts from session store; violates SQLite-first state policy             |
| Always use `/acp spawn` + peer `sessions_send`        | Interactive sessions lack parent ownership → full A2A ping-pong           |
| Relax `mode=session` globally without `delegate` flag | Persistent unbound sessions without explicit hub semantics or lifecycle   |
| New gateway RPC `delegates.send`                      | Duplicates `sessions_send`; more surface area                             |
| `/delegates` command namespace                        | Shipped under existing `/acp delegate` operator surface                   |
| Global label uniqueness in harness store              | Breaks multi-owner hub surfaces; conflicts with owner-scoped product docs |

## Compatibility

- **Config (additive):** `acp.delegate.idleHours`, `acp.delegate.maxAgeHours` (schema + label/help metadata).
- **Upgrade:** sessions without `hubDelegated` unchanged.
- **Docs:** [ACP agents](/tools/acp-agents), [Session tools](/concepts/session-tool), [Configuration reference](/gateway/configuration-reference#acp).

## Test plan (covered in branch)

| Case                                                   | Expect                                            |
| ------------------------------------------------------ | ------------------------------------------------- | ------ | -------------------------------------------------- |
| Hub spawns `delegate: true` without thread             | accepted; persistent ACP session created          |
| `mode=session` without `thread` and without `delegate` | unchanged error                                   |
| `delegate: true` + `thread: true`                      | rejected                                          |
| Owner `sessions_send` to delegate                      | delivered; A2A skipped; inline reply when waiting |
| Non-owner with `visibility: all` + normal label        | normal label resolve (not owner-scoped)           |
| Owner hub-delegated label resolve                      | owner-scoped; retry on ambiguity                  |
| `sessions_list(delegated: true)`                       | only owner's delegated rows                       |
| Duplicate label for same owner                         | error at spawn and `sessions.patch`               |
| Same label across different owners                     | allowed                                           |
| Label reuse after close                                | allowed when old row has no active `hubDelegated` |
| `/acp delegate list                                    | status                                            | close` | JSON-store discovery includes store-only delegates |
| Maintenance expiry                                     | sweeps JSON `hubDelegated`; marker-first close    |
| Sandbox hub spawn                                      | forbidden (unchanged)                             |

## Design decisions (resolved)

| Question                          | Decision                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ------ | --------------------------------------- |
| Parameter name                    | **`delegate: true`** on `sessions_spawn` when `runtime: "acp"`                               |
| `delegate: true` + `thread: true` | **Hard error** (`delegate_thread_conflict`)                                                  |
| Hub `/new` / `/reset`             | **Delegates survive** unless explicitly closed (no auto-close in this delivery)              |
| Label uniqueness                  | **Per owner** among active hub-delegated workers; shared helper for spawn + `sessions.patch` |
| Omit `label`                      | **Auto-generate** `delegate-YYYYMMDD-HHMMSS` (UTC) with suffix on collision                  |
| Initial `task`                    | Required on spawn (same as other ACP spawns)                                                 |
| Cross-agent delegate              | Follows existing `agentToAgent` / spawn policy                                               |
| Operator commands                 | **Shipped:** `/acp delegate list                                                             | status | close`(not a separate`/delegates` tree) |
| Close surface                     | **Operator commands + maintenance**; hub agents use spawn/send/list only                     |

## Acceptance criteria

- [x] Hub session on a non-thread channel can spawn a persistent ACP delegate without thread binding.
- [x] Owner can list delegated sessions via `sessions_list({ delegated: true })`.
- [x] Owner can send follow-ups via `sessions_send` by `label` without A2A ping-pong.
- [x] Unrelated sessions retain existing A2A behavior when messaging the same target.
- [x] Ownership and cleanup remain session-store-backed; no parallel routing file.
- [x] Operator lifecycle via `/acp delegate` aligned with maintenance discovery.
- [x] Docs updated; tests cover visibility, skip-A2A, spawn gate, label ownership, lifecycle, and config schema.

## Related

- [ACP agents](/tools/acp-agents)
- [Session tools](/concepts/session-tool)
- [Sub-agents](/tools/subagents)
- [ACP lifecycle refactor](/refactor/acp)
- [Delegate architecture](/concepts/delegate-architecture) (different concept)

## Revision history

| Date       | Author      | Change                                                                                                                                         |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-05 | @scotthuang | Initial draft                                                                                                                                  |
| 2026-06-05 | @scotthuang | Implementation on `feat/acp-hub-delegated-sessions`                                                                                            |
| 2026-06-07 | @scotthuang | Aligned to shipped design: `/acp delegate`, `hubDelegated` metadata, owner-scoped labels, maintenance/operator JSON sweep; removed MVP phasing |

## Follow-up (outside this feature)

- **Stuck-session recovery race (core):** When `sessions_send` / `agent.wait` returns while stuck-session recovery aborts the hub run, the user can see silence after “I will send…”. General core fix in stuck-session recovery — not hub-delegated-specific. Bundled idle-handle and wait-timeout fixes on the feature branch address related dogfood pain but do not replace a full stuck-session redesign.
