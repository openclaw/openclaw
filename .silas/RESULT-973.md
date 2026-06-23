# RESULT — issue #973 (silas/973-union)

## Summary

Adds a terminal `[[CONTINUE_WORK]]` / `[[CONTINUE_WORK:<delay>]]` bracket-token
grammar that mirrors the existing `[[CONTINUE_DELEGATE: ...]]` convention, so
tool-less / light-context continuation surfaces aren't forced to depend on the
bare `CONTINUE_WORK` token alone. Parser + stripper updated in
`src/auto-reply/tokens.ts`; tests cover the new grammar end-to-end, including
the dangling-delimiter regression on `stripContinuationSignal`.

Also adds the issue-#973 proof pair in
`src/agents/command/attempt-execution.continue-work-opts.test.ts`:

- A behavioral case that exercises the chain-depth reject branch deterministically
  by seeding a session already at the configured cap and emitting a terminal
  `[[CONTINUE_WORK]]` token — without mutating the protected
  `agents.defaults.continuation.maxChainLength` config path, and without going
  near `config.patch` / raw file edits / gateway restarts.
- A guardrail case that asserts `assertGatewayConfigMutationAllowedForTest`
  still rejects a `config.patch` attempt against `maxChainLength`, so the
  protection that the runtime test deliberately walks around at the seed layer
  remains live at the gateway-tool boundary.

The two pre-existing post-bracket tests that exercised `CONTINUE_WORK` in
contexts that now collide with the broader bracket grammar were updated to use
the bracket form (`[[CONTINUE_WORK]]` / `[[CONTINUE_WORK:60]]`); their
assertions are unchanged.

## Gates

| Gate                                                                                                                                                                           | Result                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `NO_COLOR=1 FORCE_COLOR=0 node --no-opt scripts/run-vitest.mjs run src/auto-reply/tokens.continuation.test.ts src/agents/command/attempt-execution.continue-work-opts.test.ts` | ✅ 31 + 15 passed (2 shards, 6.29s wall) |
| `pnpm tsgo:core`                                                                                                                                                               | ✅ exit=0                                |
| `pnpm build`                                                                                                                                                                   | ✅ exit=0 (98.7s total; tsdown 68.3s)    |

## Diffstat

```
.../attempt-execution.continue-work-opts.test.ts   | 54 ++++++++++++++++++++--
 src/auto-reply/tokens.continuation.test.ts         | 27 +++++++++++
 src/auto-reply/tokens.ts                           | 19 ++++++++
 3 files changed, 97 insertions(+), 3 deletions(-)
```

## Files changed

- `src/auto-reply/tokens.ts` — bracket `[[CONTINUE_WORK]]` grammar in
  `parseContinuationSignal` + matching strip branch in
  `stripContinuationSignal` (must run before the bare-token replacement to
  avoid leaking a dangling `[[`).
- `src/auto-reply/tokens.continuation.test.ts` — 5 new cases (3 parse + 2
  strip) for the bracket grammar.
- `src/agents/command/attempt-execution.continue-work-opts.test.ts` — adds the
  two #973 proof-pair cases; updates two pre-existing post-bracket tests to
  the bracket form.

## Base

`frond-scribe/20260613/assembly-drift-cure` — same train the upstream
spawn-init / lane-routing work is riding.
