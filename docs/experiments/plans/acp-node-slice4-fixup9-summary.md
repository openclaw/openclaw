# ACP Node Slice 4 Fixup 9 Summary

## What changed

- `src/auto-reply/reply/dispatch-acp-replay.ts` now treats the durable prepared synthetic-final marker as resendable payload state, not as proof that the final was already delivered. Recovery only settles the synthetic-final checkpoint without resending when it has real post-send evidence from the pending/checkpoint marker or from the mirrored session transcript idempotency key.
- `src/config/sessions/transcript.ts`, `src/auto-reply/reply/route-reply.ts`, and `src/auto-reply/reply/dispatch-acp-delivery.ts` now thread a synthetic-final idempotency key through mirrored routed delivery so replay/startup can distinguish “prepared but unsent” from “sent but ACP post-send durability was lost”.

## What is now proven

- if the prepared marker was written but `coordinator.deliver("final", ...)` failed, restart and retry keep `projector:${runId}:primary` at `deliveredEffectCount: 1` until a real successful final delivery occurs
- if synthetic final delivery succeeded and every ACP post-send durability write was lost, restart still converges without duplicate final output by recognizing the transcript-backed synthetic-final idempotency evidence
- startup recovery now covers both prepared-marker branches: one final send when there is no durable sent evidence, and no resend when transcript evidence proves the final already went out
