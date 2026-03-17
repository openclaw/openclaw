# ACP Node Slice 4 Final Judge

Reviewed head:

- `d731f4999` `ACP: infer transcript scope for replay evidence`
- `b6de38fa2` `ACP: format prepared final recovery tests`
- `77d34c1b9` `ACP: require sent evidence for prepared finals`
- `7bafed0af` `ACP: persist synthetic final pre-send evidence`
- `c6f3d2a88` `ACP: harden synthetic final marker-write recovery`
- `229d3aeb0` `ACP: harden final checkpoint recovery`
- `84e16f616` `ACP: preserve restart final TTS parity`
- `5d610a9db` `ACP: add slice-4 proof coverage`
- `c0238fe7b` `ACP: fix live retry block accumulation`
- `92842594a` `ACP: fix session-route durable projection checkpointing`

Reviewed against:

- `docs/experiments/plans/acp-node-slice4-plan.md`
- `docs/experiments/plans/acp-node-slice4-verification-plan.md`
- `docs/experiments/plans/acp-node-slice4-summary.md`
- `docs/experiments/plans/acp-node-slice4-fixup8-adversary-review.md`
- `docs/experiments/plans/acp-node-slice4-fixup9-summary.md`

Verification performed:

- reviewed the current implementation in `src/acp/store/store.ts`, `src/acp/store/types.ts`, `src/auto-reply/reply/dispatch-acp.ts`, `src/auto-reply/reply/dispatch-acp-delivery.ts`, `src/auto-reply/reply/dispatch-acp-replay.ts`, `src/auto-reply/reply/route-reply.ts`, `src/config/sessions/transcript.ts`, `src/gateway/server-startup.acp-node.ts`, and `src/gateway/server-node-events.ts`
- reran the slice-4 gate:
  - `pnpm test -- src/auto-reply/reply/acp-projector.test.ts src/auto-reply/reply/dispatch-acp.test.ts src/auto-reply/reply/dispatch-acp-delivery.test.ts src/auto-reply/reply/dispatch-acp.replay.test.ts src/acp/store/store.test.ts src/acp/store/store.restart.test.ts src/acp/store/gateway-events.test.ts src/gateway/server-node-events.acp.test.ts src/gateway/server-startup.acp-node.test.ts src/node-host/invoke-acp.test.ts src/gateway/server-methods/nodes.acp.test.ts`
  - result: all selected suites passed
- reran the focused non-`main` replay proof:
  - `pnpm test -- src/auto-reply/reply/dispatch-acp.replay.test.ts`
  - result: passed
- reran `pnpm tsgo`
  - result: passed
- reran `pnpm build`
  - result: still fails only with the same unchanged Bun/module-resolution wrapper error: `Cannot find module './cjs/index.cjs' from ''`

## Verdict

`ACCEPTED`

## Judgment

### 1. Slice 4 now actually separates runtime polling progress from outward delivery progress

- projector checkpoints are durable records separate from `runtime:${runId}`, and the replay runner advances them only after confirmed outward delivery in `src/acp/store/store.ts` and `src/auto-reply/reply/dispatch-acp-replay.ts`
- the durable runner is now the live `acp-node` delivery path as well as the restart path, which closes the earlier “happy-path live code is different from replay code” gap in `src/auto-reply/reply/dispatch-acp.ts` and `src/auto-reply/reply/dispatch-acp-replay.ts`
- the checked-in replay/store/startup suites now prove restart only emits the unfinished remainder, not an entire replay from seq 1 and not a silently skipped suffix

That satisfies the slice-4 plan’s projector/checkpoint split and the verification contract items around V1.1-V1.5 and V3.1-V3.5.

### 2. Restart and startup recovery now distinguish prepared, sent, and durably checkpointed synthetic finals coherently

- the prepared synthetic-final marker now captures only resendable payload state, not proof that delivery already happened, in `src/auto-reply/reply/dispatch-acp-replay.ts`
- replay first honors true post-send evidence from the pending marker, then transcript-backed idempotency evidence, and only otherwise resends the prepared final
- the current replay/startup proofs cover all three critical branches:
  - prepared marker written but final send failed: checkpoint stays at `deliveredEffectCount: 1` until a real successful final delivery occurs
  - final send succeeded and ACP post-send durability was lost: restart converges without duplicate final output
  - prepared marker recovery on startup: resend when no sent evidence exists, no resend when transcript evidence proves the final already went out

That closes the blocker raised in `docs/experiments/plans/acp-node-slice4-fixup8-adversary-review.md` and satisfies the acceptance-critical crash windows behind V1.2, V3.3, V5.2, and the related slice-4 final-mode TTS parity requirements.

### 3. The transcript-backed sent-evidence path is now agent-scoped correctly

- the final fix in `src/config/sessions/transcript.ts` now infers the agent store from `sessionKey` when callers omit `agentId`
- the replay proof in `src/auto-reply/reply/dispatch-acp.replay.test.ts` now exercises the “sent but ACP writes lost” path on a non-`main` session key, which would have duplicated before this fix

That closes the remaining scope hole in the fixup-9 design instead of leaving the transcript-evidence path accidentally correct only for `agent:main:*` sessions.

### 4. The slice-3 carry-forward lifecycle and reconnect seams remain green on the accepted path

- the rerun gate still passes `src/node-host/invoke-acp.test.ts`, `src/acp/store/gateway-events.test.ts`, and `src/gateway/server-node-events.acp.test.ts`
- I did not find a new regression in cancel/close lifecycle, reconnect ordering, or status-normalization while re-reviewing the slice-4 replay and startup changes

## Non-blocking carry-forward

1. `pnpm build` remains red under the local Bun wrapper because `node` resolves through Bun and fails with `Cannot find module './cjs/index.cjs' from ''`. That failure predates the slice-4 fixes in this branch and did not change across the reruns above.
2. The slice-4 summary/fixup docs and this final-judge doc still depend on the repo’s doc helper path, which currently fails with the existing `DataCloneError` on these `docs/experiments/plans/*` files.

## Decision

Slice 4 is accepted for progression.
