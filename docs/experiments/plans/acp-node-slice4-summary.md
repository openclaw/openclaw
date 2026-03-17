# ACP Node Slice 4 Summary

## What changed

Slice 4 lands the gateway-owned replay path for `acp-node` turns.

- `src/acp/store/store.ts` and `src/acp/store/types.ts` now persist run-scoped delivery targets plus projector checkpoints that are separate from the existing runtime cursor.
- `src/auto-reply/reply/dispatch-acp.ts` persists the delivery target before replayable output matters and starts durable projection for `acp-node` turns instead of relying only on the live `runTurn()` iterator.
- `src/auto-reply/reply/dispatch-acp-replay.ts` adds the durable projection runner that reads accepted worker events and canonical terminal state from the gateway store, replays missing projector effects, and advances checkpoints only after successful delivery.
- `src/gateway/server-startup.acp-node.ts` and `src/gateway/server-startup.ts` now resume ACP node projection recovery on startup from durable store state.
- Fixup 1 keeps the live durable `acp-node` path on the same delivery coordinator as the outer dispatch flow, so routed block/tool/final counts and final-mode ACP TTS still observe the real streamed output from the durable runner.
- Fixup 2 keeps the live durable path on a target-backed coordinator for actual outbound confirmation while sharing delivery state with the outer dispatch flow, so the session-route lane no longer checkpoints queued-but-unsent output.
- Fixup 3 distinguishes tentative from confirmed live block state so transient live retries no longer double-append accumulated block text or block counts before final-mode ACP TTS runs.
- Fixup 4 adds the missing contract-level proof coverage for repeated startup recovery after a real disk-backed restart boundary and for reconnect ordering relative to durable replay.
- Fixup 5 persists replay-relevant TTS context on durable targets and moves the synthetic final-mode ACP TTS branch into the shared replay path so restart recovery preserves the live final-output contract instead of silently degrading to text-only replay.
- Fixup 6 adds a durable tentative-vs-checkpointed synthetic-final state so the replay runner can recover from “final audio send succeeded, checkpoint write failed” without duplicate final output and without getting the projector checkpoint stuck behind the fully delivered state.
- Fixup 7 hardens the remaining synthetic-final write ordering: after final outbound delivery succeeds, the runner now prefers writing the fully settled projector checkpoint first, falls back to the durable pending-final marker only when that checkpoint write fails, and retries the full checkpoint once more if the marker write also fails. The shared live delivery state now also remembers that a synthetic final already went out, so same-process live retries can finish checkpoint recovery without re-emitting the final.
- Fixup 8 adds a durable pre-send synthetic-final marker that captures the resolved final payload before the final send becomes externally visible. That gives restart recovery a durable copy of the exact synthetic-final payload even when every post-send ACP write is lost after a successful final outbound delivery.
- Fixup 9 stops treating that prepared marker as proof that the final already went out. Replay and startup recovery now use the prepared marker only as resendable payload state, and they rely on durable sent evidence from the session transcript idempotency key or the post-send pending/checkpoint state before settling the projector checkpoint without another final emission.

## What is proven

The current slice-4 test coverage proves the main hardened recovery contract:

- runtime cursor and projector checkpoint state survive reload independently
- replay targets are persisted at run scope and stay isolated across multiple runs on the same session
- startup recovery discovers terminal-persisted but unprojected runs from durable state
- startup recovery remains idempotent across repeated boots with a true disk-backed memory cut, using fresh projector/delivery instances on the second boot without redelivering already checkpointed output
- restart replay can resume only the unfinished remainder after a crash window
- restart harness coverage proves replay uses fresh projector/delivery instances after the crash boundary
- live durable dispatch preserves routed block/tool/final accounting in the returned dispatch result
- live durable dispatch still triggers final-mode ACP TTS synthesis from streamed block text
- durable targets now persist the replay-relevant TTS context needed to reconstruct final-mode output after restart
- live session-route durable projection does not advance the projector checkpoint until the outbound send is actually confirmed
- restart replay still delivers session-route output when the pre-crash process died before any projector checkpoint was durably recorded
- transient live block delivery failures followed by retry do not double accumulated block text, block counts, or final-mode ACP TTS input
- durable replay and reconnect status reconcile compose in deterministic order: accepted pre-disconnect output replays first, duplicate reconnect event suffixes stay suppressed, and new post-reconnect suffixes advance the same projector checkpoint after replay
- restart recovery and startup replay preserve final-mode ACP TTS parity with the live path when the durable target carries `sessionTtsAuto`, `ttsChannel`, and `inboundAudio`
- if synthetic final audio is sent successfully but the durable checkpoint write fails, replay now converges safely from a durable pending-final marker: retries and restarts do not resend the final output, do not need to re-deliver the already checkpointed block effect to rebuild final context, and still advance `projector:${runId}:primary` to the fully delivered state
- if the first post-send checkpoint write fails and the fallback pending-final marker write also fails once, the runner now retries the fully settled checkpoint before giving up, so the exact fixup-6 pre-marker failure window no longer strands `deliveredEffectCount` or requires a duplicate final
- if a live durable retry re-enters after the synthetic final already went out but before any durable final state landed, the shared delivery state now suppresses a second final emission while the retry finishes checkpoint convergence
- if the process dies after synthetic final delivery but before any post-send ACP write lands, restart still converges from the durable prepared payload plus transcript-backed synthetic-final idempotency evidence and promotes `projector:${runId}:primary` to the fully delivered state without re-emitting the final
- if a durable prepared synthetic-final marker exists but the final never actually went out, replay/startup do not falsely promote `deliveredEffectCount` from `1` to `2`; recovery keeps that checkpoint pending until a real successful final delivery occurs
- startup recovery now covers both prepared-marker branches: it emits the pending final when no transcript evidence exists, and it skips the resend only when transcript evidence proves the final already went out
- accepted slice-3 node-host lifecycle, reconnect, and status-normalization regressions remain green

## Explicit v1 downgrade and non-goals

Slice 4 chooses the documented conservative tool replay rule:

- post-restart tool updates use `append_only_after_restart`
- resumed tool-message edit handles are not claimed as durable in v1

Still out of scope for this slice:

- automatic cross-node continuation for an in-flight run
- broader operator UX/doctor polish beyond local replay recovery
- richer resumed tool-edit behavior after restart
