---
summary: "Discord thread bound subagent sessions with plugin lifecycle hooks, routing, and config kill switches"
owner: "onutc"
status: "implemented"
last_updated: "2026-02-21"
title: "Thread Bound Subagents"
---

# Thread Bound Subagents

## Overview

This feature lets users interact with spawned subagents directly inside Discord threads.

Instead of only waiting for a completion summary in the parent session, users can move into a dedicated thread that routes messages to the spawned subagent session. Replies are sent in-thread with a thread bound persona.

The implementation is split between channel agnostic core lifecycle hooks and Discord specific extension behavior.

## Goals

- Allow direct thread conversation with a spawned subagent session.
- Keep default subagent orchestration channel agnostic.
- Support both automatic thread creation on spawn and manual focus controls.
- Provide predictable cleanup on completion, kill, timeout, and thread lifecycle changes.
- Keep behavior configurable with global defaults plus channel and account overrides.

## Out of scope

- New ACP protocol features.
- Non Discord thread binding implementations in this document.
- New bot accounts or app level Discord identity changes.

## What shipped

- `sessions_spawn` supports `thread: true` and `mode: "run" | "session"`.
- Spawn flow supports persistent thread bound sessions.
- Discord thread binding manager supports bind, unbind, TTL sweep, and persistence.
- Plugin hook lifecycle for subagents:
  - `subagent_spawning`
  - `subagent_spawned`
  - `subagent_delivery_target`
  - `subagent_ended`
- Discord extension implements thread auto bind, delivery target override, and unbind on end.
- Text commands for manual control:
  - `/focus`
  - `/unfocus`
  - `/agents`
  - `/session ttl`
- Global and Discord scoped enablement and TTL controls, including a global kill switch.

## Core concepts

### Spawn modes

- `mode: "run"`
  - one task lifecycle
  - completion announcement flow
- `mode: "session"`
  - persistent thread bound session
  - supports follow up user messages in thread

Default mode behavior:

- if `thread: true` and mode omitted, mode defaults to `"session"`
- otherwise mode defaults to `"run"`

Constraint:

- `mode: "session"` requires `thread: true`

### Thread binding target model

Bindings are generic targets, not only subagents.

- `targetKind: "subagent" | "acp"`
- `targetSessionKey: string`

This allows the same routing primitive to support ACP/session bindings as well.

### Thread binding manager

The manager is responsible for:

- binding or creating threads for a session target
- unbinding by thread or by target session
- managing webhook reuse and recent unbound webhook echo suppression
- TTL based unbind and stale thread cleanup
- persistence load and save

## Architecture

### Core and extension boundary

Core (`src/agents/*`) does not directly depend on Discord routing internals.

Core emits lifecycle intent through plugin hooks.

Discord extension (`extensions/discord/src/subagent-hooks.ts`) implements Discord specific behavior:

- pre spawn thread bind preparation
- completion delivery target override to bound thread
- unbind on subagent end

### Plugin hook flow

1. `subagent_spawning`
   - before run starts
   - can block spawn with `status: "error"`
   - used to prepare thread binding when `thread: true`
2. `subagent_spawned`
   - post run registration event
3. `subagent_delivery_target`
   - completion routing override hook
   - can redirect completion delivery to bound Discord thread origin
4. `subagent_ended`
   - cleanup and unbind signal

### Account ID normalization contract

Thread binding and routing state must use one canonical account id abstraction.

Specification:

- Introduce a shared account id module (proposed: `src/routing/account-id.ts`) and stop defining local normalizers.
- Expose two explicit helpers:
  - `normalizeAccountId(value): string`
    - returns canonical, defaulted id (current default is `default`)
    - use for map keys, manager registration and lookup, persistence keys, routing keys
  - `normalizeOptionalAccountId(value): string | undefined`
    - returns canonical id when present, `undefined` when absent
    - use for inbound optional context fields and merge logic
- Do not implement ad hoc account normalization in feature modules.
  - This includes `trim`, `toLowerCase`, or defaulting logic in local helper functions.
- Any map keyed by account id must only accept canonical ids from shared helpers.
- Hook payloads and delivery context should carry raw optional account ids, and normalize at module boundaries only.

Migration guardrails:

- Replace duplicate normalizers in routing, reply payload, command context, and provider helpers with shared helpers.
- Add contract tests that assert identical normalization behavior across:
  - route resolution
  - thread binding manager lookup
  - reply delivery target filtering
  - command run context merge

### Persistence and state

Binding state path:

- `${stateDir}/discord/thread-bindings.json`

Record shape contains:

- account, channel, thread
- target kind and target session key
- agent label metadata
- webhook id/token
- boundBy, boundAt, expiresAt

State is stored on `globalThis` to keep one shared registry across ESM and Jiti loader paths.

## Configuration

### Effective precedence

For Discord thread binding options, account override wins, then channel, then global session default, then built in fallback.

- account: `channels.discord.accounts.<id>.threadBindings.<key>`
- channel: `channels.discord.threadBindings.<key>`
- global: `session.threadBindings.<key>`

### Keys

| Key                                                     | Scope           | Default         | Notes                                     |
| ------------------------------------------------------- | --------------- | --------------- | ----------------------------------------- |
| `session.threadBindings.enabled`                        | global          | `true`          | master default kill switch                |
| `session.threadBindings.ttlHours`                       | global          | `24`            | default auto unfocus TTL                  |
| `channels.discord.threadBindings.enabled`               | channel/account | inherits global | Discord override kill switch              |
| `channels.discord.threadBindings.ttlHours`              | channel/account | inherits global | Discord TTL override                      |
| `channels.discord.threadBindings.spawnSubagentSessions` | channel/account | `false`         | opt in for `thread: true` spawn auto bind |

### Runtime effect of enable switch

When effective `enabled` is false for a Discord account:

- provider creates a noop thread binding manager for runtime wiring
- no real manager is registered for lookup by account id
- inbound bound thread routing is effectively disabled
- completion routing overrides do not resolve bound thread origins
- `/focus`, `/unfocus`, and thread binding specific operations report unavailable
- `thread: true` spawn path returns actionable error from Discord hook layer

## Flow and behavior

### Spawn with `thread: true`

1. Spawn validates mode and permissions.
2. `subagent_spawning` hook runs.
3. Discord extension checks effective flags:
   - thread bindings enabled
   - `spawnSubagentSessions` enabled
4. Extension attempts auto bind and thread creation.
5. If bind fails:
   - spawn returns error
   - provisional child session is deleted
6. If bind succeeds:
   - child run starts
   - run is registered with spawn mode

### Manual focus and unfocus

- `/focus <target>`
  - Discord only
  - resolves subagent or session target
  - binds current or created thread to target session
- `/unfocus`
  - Discord thread only
  - unbinds current thread

### Inbound routing

- Discord preflight checks current thread id against thread binding manager.
- If bound, effective session routing uses bound target session key.
- If not bound, normal routing path is used.

### Outbound routing

- Reply delivery checks whether current session has thread bindings.
- Bound sessions deliver to thread via webhook aware path.
- Unbound sessions use normal bot delivery.

### Completion routing

- Core completion flow calls `subagent_delivery_target`.
- Discord extension returns bound thread origin when it can resolve one.
- Core merges hook origin with requester origin and delivers completion.

### Cleanup

Cleanup occurs on:

- completion
- error or timeout completion path
- kill and terminate paths
- TTL expiration
- archived or deleted thread probes
- manual `/unfocus`

Cleanup behavior includes unbind and optional farewell messaging.

## Commands and user UX

| Command                                                    | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- | --------------- | ------------------------------------------- |
| `/subagents spawn <agentId> <task> [--model] [--thinking]` | spawn subagent; may be thread bound when `thread: true` path is used |
| `/focus <subagent-label                                    | session-key                                                          | session-id                            | session-label>` | manually bind thread to subagent or session |
| `/unfocus`                                                 | remove binding from current thread                                   |
| `/agents`                                                  | list active agents and binding state                                 |
| `/session ttl <duration                                    | off>`                                                                | update TTL for focused thread binding |

Notes:

- `/session ttl` is currently Discord thread focused behavior.
- Thread intro and farewell text are generated by thread binding message helpers.

## Failure handling and safety

- Spawn returns explicit errors when thread binding cannot be prepared.
- Spawn failure after provisional bind attempts best effort unbind and session delete.
- Completion logic prevents duplicate ended hook emission.
- Retry and expiry guards prevent infinite completion announce retry loops.
- Webhook echo suppression avoids unbound webhook messages being reprocessed as inbound turns.

## Module map

### Core orchestration

- `src/agents/subagent-spawn.ts`
- `src/agents/subagent-announce.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/subagent-registry-cleanup.ts`
- `src/agents/subagent-registry-completion.ts`

### Discord runtime

- `src/discord/monitor/provider.ts`
- `src/discord/monitor/thread-bindings.manager.ts`
- `src/discord/monitor/thread-bindings.state.ts`
- `src/discord/monitor/thread-bindings.lifecycle.ts`
- `src/discord/monitor/thread-bindings.messages.ts`
- `src/discord/monitor/message-handler.preflight.ts`
- `src/discord/monitor/message-handler.process.ts`
- `src/discord/monitor/reply-delivery.ts`

### Plugin hooks and extension

- `src/plugins/types.ts`
- `src/plugins/hooks.ts`
- `extensions/discord/src/subagent-hooks.ts`

### Config and schema

- `src/config/types.base.ts`
- `src/config/types.discord.ts`
- `src/config/zod-schema.session.ts`
- `src/config/zod-schema.providers-core.ts`
- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`

## Test coverage highlights

- `extensions/discord/src/subagent-hooks.test.ts`
- `src/discord/monitor/thread-bindings.ttl.test.ts`
- `src/discord/monitor/thread-bindings.shared-state.test.ts`
- `src/discord/monitor/reply-delivery.test.ts`
- `src/discord/monitor/message-handler.preflight.test.ts`
- `src/discord/monitor/message-handler.process.test.ts`
- `src/auto-reply/reply/commands-subagents-focus.test.ts`
- `src/auto-reply/reply/commands-session-ttl.test.ts`
- `src/agents/subagent-registry.steer-restart.test.ts`
- `src/agents/subagent-registry-completion.test.ts`

## Operational summary

- Use `session.threadBindings.enabled` as the global kill switch default.
- Use `channels.discord.threadBindings.enabled` and account overrides for selective enablement.
- Keep `spawnSubagentSessions` opt in for thread auto spawn behavior.
- Use TTL settings for automatic unfocus policy control.

This model keeps subagent lifecycle orchestration generic while giving Discord a full thread bound interaction path.

## Related plan

For channel agnostic SessionBinding architecture and scoped iteration planning, see:

- `docs/experiments/plans/session-binding-channel-agnostic.md`

ACP remains a next step in that plan and is intentionally not implemented in this shipped Discord thread-bound flow.
