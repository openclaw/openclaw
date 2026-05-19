---
summary: "Follow-up request for Claude Code: finish post-Core-Harness hardening, fix the task-registry permission fault, and repair dashboard-to-Discord direct-session sync."
title: "Core harness follow-up and Discord direct sync request"
read_when:
  - Investigating why a dashboard/webchat DM is appended to a Discord-scoped direct session but does not stay visible from Discord
  - Finishing the post-Core-Harness cleanup after a fresh self-check
  - Refactoring delivery-context persistence or recovery for externally scoped direct sessions
---

# Core harness follow-up and Discord direct sync request

This document is a targeted implementation request for the next Claude Code pass.

## Requested outcome

Please handle these items in one review + refactor pass, in this order:

1. Fix the runtime fault around task-registry restore (`~/.openclaw/tasks` chmod EPERM).
2. Fix the dashboard/webchat to Discord direct-session sync gap.
3. Re-check the remaining Core Harness follow-up items after the two fixes above.
4. Leave `exec-approvals` drift cleanup as a smaller follow-up unless it becomes necessary for the main fixes.

## Current high-confidence findings

### 1. Core Harness itself is mostly in better shape now

On the real OpenClaw home (`HOME=/Users/hide_aibo`), `openclaw doctor --json` now shows:

- `effectiveHome=/Users/hide_aibo`
- config readable
- wrapper detection present
  - `openclaw-setup alias=true`
  - `homeResolver=true`
- only one current Core Harness warning:
  - `core-harness.exec-approvals.drift`

This means the earlier wrapper/home-resolver regression appears fixed.

### 2. There is still a runtime fault unrelated to the wrapper fix

`/tmp/openclaw/openclaw-2026-05-18.log` reports:

- `Failed to restore task registry`
- `EPERM`
- `syscall: chmod`
- `path: /Users/hide_aibo/.openclaw/tasks`

That lines up with host-side symptoms where `status` / `health` become noisy or unreliable.

Treat this as a real runtime problem, not just a doctor cosmetic issue.

### 3. The dashboard/webchat DM is attached to a Discord-scoped direct session key, but the stored delivery route is incomplete

Current active session key:

- `agent:main:discord:direct:1490529714870157373`

Current stored entry in:

- `~/.openclaw/agents/main/sessions/sessions.json`

Important fields observed:

```json
{
  "chatType": "direct",
  "deliveryContext": {
    "channel": "discord"
  },
  "lastChannel": "discord",
  "origin": {
    "provider": "webchat",
    "surface": "webchat",
    "chatType": "direct"
  }
}
```

What is missing:

- `deliveryContext.to`
- `deliveryContext.accountId`
- `deliveryContext.threadId`
- `lastTo`
- `lastAccountId`
- `lastThreadId`

That is the strongest concrete clue for why Discord no longer shows the current conversation even though the dashboard transcript keeps moving.

### 4. Current routing helpers require a real destination, not just a channel name

`src/utils/delivery-context.shared.ts`

- `deliveryContextFromSession()` rebuilds a route from persisted `deliveryContext`, `lastTo`, `lastAccountId`, and `lastThreadId`
- it does **not** recover a direct-peer target from the session key when those fields are missing

`src/auto-reply/reply/routing-policy.ts`

- `resolveReplyRoutingDecision()` only sets `shouldRouteToOriginating` when `originatingTo` exists

That means a session can remain keyed as a Discord direct session while still being non-routable for outbound delivery if `to` was lost or never persisted.

### 5. This matches an older known source-gap pattern

Archived note:

- `~/.openclaw/workspace/_inbox/archived/proposals/discord-dashboard-sync-source-gap-handoff-2026-04-09.md`

That handoff already pointed at related likely hotspots:

- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/gateway/server-methods/chat.ts`
- `src/auto-reply/reply/routing-policy.ts`

It also described the same practical symptom: the conversation continues in the browser transcript but stops being visible from Discord.

## Working hypothesis

The current dashboard/webchat continuation path is reusing or reopening a Discord direct-session key, but it is not preserving a full routable delivery context.

As a result:

1. the session still looks like a Discord direct session from its key
2. the dashboard transcript continues normally
3. outbound routing has no stable `to` target to send back to Discord
4. Discord appears stale, which matches the user report that the visible date there is stuck on 2026-05-12

## Requested implementation work

### A. Fix delivery-context persistence and recovery for externally scoped direct sessions

Audit the code path that creates or refreshes a session when the operator continues an external direct session from the dashboard/webchat.

Focus on:

- `src/gateway/server-methods/chat.ts`
- `src/auto-reply/reply/session-delivery.ts`
- `src/utils/delivery-context.shared.ts`
- `src/infra/outbound/targets.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`

Expected behavior:

- if the session is an externally scoped direct session (Discord, Telegram, etc.), keep or restore a full routable delivery context
- do not settle for `deliveryContext.channel` alone
- persist `to`, `accountId`, and `threadId` when they are known
- keep `lastTo`, `lastAccountId`, and `lastThreadId` aligned with that route

### B. Add a safe fallback when the session key itself contains a direct external peer id

If a session key is channel-scoped and direct, for example:

- `agent:main:discord:direct:<peer-id>`

and the stored delivery context is missing `to`, consider a guarded recovery path:

- derive a routable target from the session key only when there is no conflicting explicit route
- keep the fallback channel-specific and direct-session-only
- avoid broad route inheritance for unrelated webchat sessions

This should be treated as a repair/fallback, not a replacement for correct persistence.

### C. Re-check `sessions_send` announce delivery context

The older handoff singled out `src/agents/tools/sessions-send-tool.a2a.ts`.

Please verify that announce delivery always preserves:

- `to`
- `accountId`
- `threadId`

for Discord and other threaded channels.

### D. Fix or harden the task-registry restore path

Investigate why runtime is attempting a `chmod` that fails with EPERM on:

- `~/.openclaw/tasks`

Even if the underlying permission model stays strict, the runtime should not degrade basic status/health flows because of this.

## Acceptance checks

### Dashboard / Discord sync

A Discord direct session that is continued from the dashboard/webchat should:

- still update the visible latest message from Discord
- still update the visible latest date/time from Discord
- keep its stored session route fully routable after the webchat turn

### Session store correctness

After a webchat/dashboard continuation of a Discord direct session, the stored entry should retain or recover:

- `deliveryContext.channel`
- `deliveryContext.to`
- `lastChannel`
- `lastTo`

and, when applicable:

- `deliveryContext.accountId`
- `deliveryContext.threadId`
- `lastAccountId`
- `lastThreadId`

### Runtime health

After the task-registry fix:

- host-side status/health should stop reporting the repeated `Failed to restore task registry` chmod warning
- the fix should not require weakening unrelated sandbox or security boundaries

## Regression tests to add

1. A session-store test for a Discord direct session continued from webchat/dashboard where `origin.provider=webchat` but the session key is `agent:main:discord:direct:<id>`.
2. A delivery-context recovery test proving that an externally scoped direct session remains routable after the continuation turn.
3. A routing test proving that replies route back to Discord only when a valid destination exists.
4. A `sessions_send` announce regression test preserving `threadId` for threaded external channels.
5. A runtime test around task-registry restore that covers the EPERM path without silently breaking status/health behavior.

## Nice-to-have follow-up after the main fixes

If time remains after the two main problems above, review these still-open warnings from doctor:

- `agents.defaults.agentRuntime` legacy key cleanup
- message-tool policy mismatch for externally routed agents
- empty Discord/Telegram group allowlists where that is unintentional
- `exec-approvals.json` drift review

Those matter, but they are lower priority than restoring correct direct-session delivery and cleaning up the task-registry fault.
