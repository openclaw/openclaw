---
summary: "Channel agnostic session binding architecture and iteration 1 delivery scope"
owner: "onutc"
status: "in-progress"
last_updated: "2026-02-21"
title: "Session Binding Channel Agnostic Plan"
---

# Session Binding Channel Agnostic Plan

## Overview

This document defines the long term channel agnostic session binding model and the concrete scope for the next implementation iteration.

Goal:

- make subagent bound session routing a core capability
- keep channel specific behavior in adapters
- avoid regressions in normal Discord behavior

## Why this exists

Current behavior mixes:

- completion content policy
- destination routing policy
- Discord specific details

This caused edge cases such as:

- duplicate main and thread delivery under concurrent runs
- stale token usage on reused binding managers
- missing activity accounting for webhook sends

## Iteration 1 scope

This iteration is intentionally limited.

### 1. Add channel agnostic core interfaces

Add core types and service interfaces for bindings and routing.

Proposed core types:

```ts
export type BindingTargetKind = "subagent" | "session";
export type BindingStatus = "active" | "ending" | "ended";

export type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

export type SessionBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  status: BindingStatus;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};
```

Core service contract:

```ts
export interface SessionBindingService {
  bind(input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversation: ConversationRef;
    metadata?: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<SessionBindingRecord>;

  listBySession(targetSessionKey: string): SessionBindingRecord[];
  resolveByConversation(ref: ConversationRef): SessionBindingRecord | null;
  touch(bindingId: string, at?: number): void;
  unbind(input: {
    bindingId?: string;
    targetSessionKey?: string;
    reason: string;
  }): Promise<SessionBindingRecord[]>;
}
```

### 2. Add one core delivery router for subagent completions

Add a single destination resolution path for completion events.

Router contract:

```ts
export interface BoundDeliveryRouter {
  resolveDestination(input: {
    eventKind: "task_completion";
    targetSessionKey: string;
    requester?: ConversationRef;
    failClosed: boolean;
  }): {
    binding: SessionBindingRecord | null;
    mode: "bound" | "fallback";
    reason: string;
  };
}
```

For this iteration:

- only `task_completion` is routed through this new path
- existing paths for other event kinds remain as-is

### 3. Keep Discord as adapter

Discord remains the first adapter implementation.

Adapter responsibilities:

- create/reuse thread conversations
- send bound messages via webhook or channel send
- validate thread state (archived/deleted)
- map adapter metadata (webhook identity, thread ids)

### 4. Fix currently known correctness issues

Required in this iteration:

- refresh token usage when reusing existing thread binding manager
- record outbound activity for webhook based Discord sends
- stop implicit main channel fallback when a bound thread destination is selected for session mode completion

### 5. Preserve current runtime safety defaults

No behavior change for users with thread bound spawn disabled.

Defaults stay:

- `channels.discord.threadBindings.spawnSubagentSessions = false`

Result:

- normal Discord users stay on current behavior
- new core path affects only bound session completion routing where enabled

## Not in iteration 1

Explicitly deferred:

- ACP binding targets (`targetKind: "acp"`)
- new channel adapters beyond Discord
- global replacement of all delivery paths (`spawn_ack`, future `subagent_message`)
- protocol level changes
- store migration/versioning redesign for all binding persistence

Notes on ACP:

- interface design keeps room for ACP
- ACP implementation is not started in this iteration

## Routing invariants

These invariants are mandatory for iteration 1.

- destination selection and content generation are separate steps
- if session mode completion resolves to an active bound destination, delivery must target that destination
- no hidden reroute from bound destination to main channel
- fallback behavior must be explicit and observable

## Compatibility and rollout

Compatibility target:

- no regression for users with thread bound spawning off
- no change to non-Discord channels in this iteration

Rollout:

1. Land interfaces and router behind current feature gates.
2. Route Discord completion mode bound deliveries through router.
3. Keep legacy path for non-bound flows.
4. Verify with targeted tests and canary runtime logs.

## Tests required in iteration 1

Unit and integration coverage required:

- manager token rotation uses latest token after manager reuse
- webhook sends update channel activity timestamps
- two active bound sessions in same requester channel do not duplicate to main channel
- completion for bound session mode run resolves to thread destination only
- disabled spawn flag keeps legacy behavior unchanged

## Proposed implementation files

Core:

- `src/infra/outbound/session-binding-service.ts` (new)
- `src/infra/outbound/bound-delivery-router.ts` (new)
- `src/agents/subagent-announce.ts` (completion destination resolution integration)

Discord adapter and runtime:

- `src/discord/monitor/thread-bindings.manager.ts`
- `src/discord/monitor/reply-delivery.ts`
- `src/discord/send.outbound.ts`

Tests:

- `src/discord/monitor/provider*.test.ts`
- `src/discord/monitor/reply-delivery.test.ts`
- `src/agents/subagent-announce.format.test.ts`

## Done criteria for iteration 1

- core interfaces exist and are wired for completion routing
- correctness fixes above are merged with tests
- no main and thread duplicate completion delivery in session mode bound runs
- no behavior change for disabled bound spawn deployments
- ACP remains explicitly deferred
