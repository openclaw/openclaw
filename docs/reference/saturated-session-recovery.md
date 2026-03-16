---
title: "Saturated Session Recovery"
summary: "Operator guide for loop-aware compaction guard, repeated-reply loops, and conservative recommend-reset recovery"
read_when:
  - You are debugging a saturated or stuck session that ignores the latest user request
  - You need the operator playbook for repeated tool-failure loops or stale reminder drift
  - You want to understand when the compaction guard augments instructions or emits recommend-reset diagnostics
---

# Saturated Session Recovery

This guide explains the **loop-aware compaction guard** and how to recover a session that is no longer tracking the latest user intent well.

It is intentionally conservative:

- It helps the compaction path preserve the **latest real user goal**.
- It tries to collapse repeated failure chatter and stale reminder text.
- It can emit a **recommend-reset** diagnostic when compaction appears insufficient.
- It does **not** automatically reset the session.

---

## What problem this guard targets

The guard is designed for the specific failure mode where a long-running session starts behaving as if the transcript itself is steering the conversation more than the latest user message.

Typical symptoms:

- the latest user request is ignored or only weakly reflected
- the assistant repeats near-duplicate replies
- the same failing tool pattern appears multiple times
- reminder/system text resurfaces as if it were the current task
- the session is near the context limit and compaction alone may preserve the wrong things

In short: **high usage + transcript contamination + weak grounding to the latest user turn**.

---

## High-level pipeline

Today, the guard pipeline is:

1. **Detect transcript-tail risk**
   - repeated tool failures
   - duplicate assistant clusters
   - stale reminder/system recurrence
   - recent user turns lacking a clearly grounded assistant reply

2. **Score risk + usage pressure**
   - combine the detector output with current context usage pressure
   - produce `score`, `action`, and `reasons`

3. **Augment compaction instructions**
   - only in the safeguard compaction path
   - only when guard is enabled
   - only for high-risk actions (`compact`, `recommend-reset`, `reset-candidate`)

4. **Validate the post-compaction result**
   - check whether the latest user goal survived
   - check whether unresolved tasks/promises survived
   - check that stale reminder/system text was not promoted
   - check that repeated failure chatter was collapsed instead of copied forward
   - check that compaction actually improved the situation

5. **Recommend reset only when compaction still fails to restore health**
   - recommendation is internal/diagnostic only
   - no auto-reset
   - no default user-visible chat output

---

## What is implemented now vs deferred

### Implemented now

- guard config surface under `agents.defaults.compaction.guard`
- transcript-tail detector
- risk scorer
- safeguard-path compaction instruction augmentation
- post-compaction validator
- conservative recommend-reset diagnostic path
- sanitized regression fixture for the incident-shaped failure mode

### Intentionally deferred

- automatic reset execution
- default user-visible recommend-reset messaging
- repeated-compaction window enforcement based on `maxCompactionsPerWindow` / `windowMinutes`
- richer operator UI for recovery decisions
- more advanced post-compaction semantic validation

---

## Current config surface

Current config lives under `agents.defaults.compaction.guard`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        guard: {
          enabled: false,
          maxCompactionsPerWindow: 3,
          windowMinutes: 30,
          escalation: "recommend-reset",
        },
      },
    },
  },
}
```

### Field semantics today

- `enabled`
  - turns the guard path on for safeguard compaction
  - when `false`, the guard is an exact no-op

- `escalation`
  - currently only `"recommend-reset"` is accepted
  - when set, severe failed post-compaction validation can emit an internal recommend-reset diagnostic
  - it does **not** reset the session and does **not** emit default user-facing chat output

- `maxCompactionsPerWindow`
- `windowMinutes`
  - parsed and validated today
  - reserved for future repeated-compaction window policy
  - they do **not** currently change runtime behavior

---

## Recommend-reset: what it means

`recommend-reset` means:

- the session looked severely unhealthy **before** compaction
- compaction ran
- the post-compaction validator still judged the result unhealthy
- the system is surfacing a structured signal that a fresh session may now be the safer recovery path

It does **not** mean:

- the session has already been reset
- OpenClaw will automatically reset it next
- user-visible warning text must be sent
- the previous work is lost

Treat it as a **conservative operator diagnostic**, not an action that has already happened.

---

## Operator recovery order

Use this order when a session appears saturated, repetitive, or weakly grounded.

1. **Confirm the failure mode**
   - Is the latest user request being ignored?
   - Are replies near-duplicate?
   - Is the same tool failure repeating?
   - Is reminder/system text resurfacing as current intent?

2. **Check whether safeguard compaction + guard is available**
   - If guard is disabled, do not assume any guard behavior is active.
   - If guard is enabled, high-risk safeguard compactions may receive stronger instructions automatically.

3. **Prefer compaction before reset**
   - The goal is to preserve the latest user goal, unresolved work, recent decisions, and meaningful assistant state.
   - Repeated failure chatter and stale reminder text should be collapsed, not copied forward verbatim.

4. **Inspect whether compaction actually helped**
   - Did the latest goal survive?
   - Did pending items survive?
   - Did usage improve or compaction count advance?
   - Was stale reminder text kept out of active state?

5. **Only then consider reset**
   - A recommend-reset diagnostic means compaction may not have restored health sufficiently.
   - Reset should still be an explicit operator decision.

6. **After reset, resume from durable state**
   - rely on committed code, docs, notes, run ledgers, and other artifacts
   - do not rely on the pre-reset transcript alone

Short version:

> **detect → compact carefully → validate → only then consider reset**

---

## Guard vs related mechanisms

### Guard vs compaction

- **Compaction** = summarize older conversation so the session can continue within context limits
- **Guard** = make compaction more robust when the session looks contaminated or weakly grounded

### Guard vs memory flush

- **Memory flush** = pre-compaction durable note write to workspace files
- **Guard** = improve what the compaction summary keeps and what it suppresses

### Guard vs pruning

- **Pruning** = trim old tool-result payloads from in-memory context
- **Guard** = reason about unhealthy transcript patterns and protect the latest real intent during compaction

### Guard vs session maintenance

- **Session maintenance** = store/transcript cleanup, retention, disk hygiene, stale artifact cleanup
- **Guard** = per-session recovery logic for saturation/repetition/drift

---

## When to use this guide

Use this guide when:

- the user says the assistant keeps repeating itself
- the assistant appears to ignore the newest request
- reminder/system residue looks like active task text
- the same tool failure pattern keeps reappearing
- a session has become large and compaction quality matters more than just compacting quickly

If the issue is instead:

- large but healthy history → ordinary compaction/pruning may be enough
- disk/store retention → see session maintenance docs
- durable note capture before compaction → see memory flush docs

---

## Related docs

- [Session Management & Compaction](/reference/session-management-compaction)
- [Configuration Reference](/gateway/configuration-reference)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
