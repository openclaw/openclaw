# Original Request

**Date:** 2026-03-11
**Source:** Codex session
**From:** Bryan

## The Ask

> Zulip no longer needs a bigger fork to get meaningfully closer to Discord. The core primitives are already live in `clawdbot/extensions/zulip`. The next pass should be a targeted plugin hardening pass: durable interactive state, productized exec approvals and model picker UX, topic lifecycle/rebinding, and startup audit/resolution polish.

## Interpreted Scope

- Replace the older Phase 3 framing with a reality-based hardening pass.
- Keep the work primarily inside `extensions/zulip`.
- Prioritize reliability and correctness over new capability work.
- Defer new `lionroot-zulip` fork work unless real usage proves button-first UX is no longer enough.

## Initial Context

- `extensions/zulip` already ships draft streaming, button send/callbacks, widget-aware reply delivery, topic-bound sessions, exec approvals, model picker helpers, typing, reactions, uploads, and target resolution helpers.
- The largest remaining gap is not transport capability; it is plugin-owned state durability and callback correctness.
- The current `components-registry.ts` and `exec-approvals.ts` both keep critical interactive state in memory only.
- `commands-approve.ts` already provides a shared text `/approve` path, so Zulip-local command work should validate reuse before adding duplication.
