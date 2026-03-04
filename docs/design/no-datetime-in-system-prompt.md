---
summary: "Why the system prompt contains only the timezone, not the current date/time"
read_when:
  - You want to add date/time to the system prompt
  - You are debugging why the agent doesn't know the current date
  - You see an issue or PR about injecting datetime into buildTimeSection
title: "Design: No Date/Time in System Prompt"
---

# Design Decision: No Date/Time in System Prompt

**Status:** Accepted (implemented)  
**Date:** 2026-01-28  
**Issues:** #1897, #3658, #34422  
**PRs:** #3705 (gateway injection), commit 66eec295b (removal)

## Context

The system prompt's "Current Date & Time" section originally included the full
formatted date and time. This was removed in commit 66eec295b because:

- **Anthropic and OpenAI cache system prompts by prefix.** A timestamp that
  changes every minute invalidates the cache on every request.
- **Cache misses cost real money and latency.** For high-volume deployments,
  the per-request cache bust adds up significantly.
- **The timezone is the only stable part.** It changes rarely (DST transitions
  at most) and is sufficient for the system prompt section.

## Decision

1. The system prompt contains **timezone only** in the "Current Date & Time" section.
2. Agents receive the current date/time through **gateway-level message injection**
   instead of the system prompt.
3. A guardian test in `system-prompt.test.ts` enforces that no date/time string
   appears in the system prompt output.

## Alternatives considered

### Put date/time back in the system prompt

Rejected. Breaks prompt caching on every request. This is the approach proposed
by issue #34422 and multiple community PRs (#34426, #34434, #28251, #29042,
#28225, #28237, etc.) — all of which conflict with this design decision.

### Opt-in config flag for system prompt datetime

Rejected. Adds complexity, creates a footgun (users enable it without
understanding the cache impact), and gateway injection already solves the
problem without any tradeoffs.

### Only use `session_status` tool

Insufficient. Small models (< 8B) don't reliably self-serve tools for context
they should have directly. Frontier models waste a tool call round-trip for
something that can be provided for free in the message.

## Consequences

- **Positive:** System prompt stays fully cacheable across requests. Agents still
  always know the current date/time from the most recent message.
- **Negative:** Contributors who don't read the docs keep filing PRs to "fix"
  the timezone-only section. The guardian test and this document exist to address
  that.
- **Trade-off:** Two different timestamp formats exist — compact gateway injection
  (`[Wed 2026-01-28 22:30 EST]`) and verbose heartbeat/cron injection
  (`Current time: Wednesday, January 28th, 2026 — 9:35 PM`). This is intentional:
  the gateway format is per-message and must be compact (~7 tokens), while
  heartbeat/cron is a one-time context line where verbosity aids readability.

## How agents receive timestamps

See the [complete coverage map in docs/date-time.md](/date-time#complete-timestamp-coverage-map).
