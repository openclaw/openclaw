---
summary: "Proposal: long-term command authorization model for ACP-bound conversations"
read_when:
  - Designing native command auth behavior in Telegram/Discord ACP-bound channels/topics
title: "ACP Bound Command Authorization (Proposal)"
---

# ACP Bound Command Authorization (Proposal)

Status: Proposed, **not implemented yet**.

This document describes a long-term authorization model for native commands in
ACP-bound conversations. It is an experiments proposal and does not replace
current production behavior.

For implemented behavior, read source and tests in:

- `src/telegram/bot-native-commands.ts`
- `src/discord/monitor/native-command.ts`
- `src/auto-reply/reply/commands-core.ts`

## Problem

Today we have command-specific checks (for example `/new` and `/reset`) that
need to work inside ACP-bound channels/topics even when allowlists are empty.
This solves immediate UX pain, but command-name-based exceptions do not scale.

## Long-term shape

Move command authorization from ad-hoc handler logic to command metadata plus a
shared policy evaluator.

### 1) Add auth policy metadata to command definitions

Each command definition should declare an auth policy. Example shape:

```ts
type CommandAuthPolicy =
  | { mode: "owner_or_allowlist" } // default, current strict behavior
  | { mode: "bound_acp_or_owner_or_allowlist" } // allow in explicitly bound ACP conversations
  | { mode: "owner_only" };
```

`/new` and `/reset` would use `bound_acp_or_owner_or_allowlist`.
Most other commands would remain `owner_or_allowlist`.

### 2) Share one evaluator across channels

Introduce one helper that evaluates command auth using:

- command policy metadata
- sender authorization state
- resolved conversation binding state

Both Telegram and Discord native handlers should call the same helper to avoid
behavior drift.

### 3) Use binding-match as the bypass boundary

When policy allows bound ACP bypass, authorize only if a configured binding
match was resolved for the current conversation (not just because current
session key looks ACP-like).

This keeps the boundary explicit and minimizes accidental widening.

## Why this is better

- Scales to future commands without adding more command-name conditionals.
- Keeps behavior consistent across channels.
- Preserves current security model by requiring explicit binding match.
- Keeps allowlists optional hardening instead of a universal requirement.

## Rollout plan (future)

1. Add command auth policy field to command registry types and command data.
2. Implement shared evaluator and migrate Telegram + Discord native handlers.
3. Move `/new` and `/reset` to metadata-driven policy.
4. Add tests per policy mode and channel surface.

## Non-goals

- This proposal does not change ACP session lifecycle behavior.
- This proposal does not require allowlists for all ACP-bound commands.
- This proposal does not change existing route binding semantics.

## Note

This proposal is intentionally additive and does not delete or replace existing
experiments documents.
