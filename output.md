# 1159 review-findings fix lane

## Fixes

- `r3520905414` / P1: deferred the early child `continue_delegate` drain when the same child output also contains a bracket `CONTINUE_DELEGATE`, then re-arms/drains from a chain state that includes the bracket hop. Added mixed bracket+tool tests proving hop 2/3 ordering and max-chain rejection.
- `r3520905416` / P2: `releasePostCompactionLifecycle` now finalizes only accepted `result.dispatchedFlowIds`, not every claimed staged row. Added accepted-only finalization coverage.
- `r3520905418` / P2: moved `resetContinueDelegateTurnBudget` to the common `runEmbeddedAgentInternal` boundary after session-key normalization, and removed caller-scattered resets so cron/direct embedded entries are covered once per run.
- `r3520905420` / P2: parent and child chain-cost persistence in subagent completion now passes `requireWriteSuccess: true`; no-op or failed writes continue to fold tokens fail-closed.
- Structural fail-closed recovery: `recoverPendingContinuationDelegates` and `recoverAndReleaseStagedPostCompactionDelegates` now leave rows queued/running and log warnings when the session store cannot load instead of spawning from `{}` / zero chain state.
- Structural deterministic/chain-seeded spawns: chain-draining spawns now require and pass `continuationChainState`; post-compaction TaskFlow and session-delivery paths pass deterministic flow ids; direct bracket and announce-path tool spawns pass child chain seeds.
- Structural cleanup: `hasRecoverablePendingDelegate` now covers queued/running regular and post-compaction delegate rows; delete-mode cleanup logs delete failures unconditionally and retries failed deletes up to 3 times.

## GitNexus

- Runbook read from `openclaw-bootstrap-local-ci-sharded/RUNBOOKS/GITNEXUS-RUNBOOK.md`.
- Seat gate passed: `free -g` reported `total: 121G available: 107G`.
- `gitnexus status`: repository not indexed before and after attempt.
- `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 gitnexus analyze --index-only --skip-git` started, warned Swift parser was unavailable, skipped 703 Swift files and 2 large files, remained unindexed after a bounded healthy run (~5.5GB RSS), then was stopped.
- No GitNexus relationship queries completed because no usable index was produced. Per runbook fallback, relationships were mapped with `rg`/`view` across the required symbols, including `dispatchToolDelegates`, both recovery helpers, post-compaction dispatch/release/delivery, `drainChildContinuationQueue`, `spawnSubagentDirect`, `resetContinueDelegateTurnBudget`, `runEmbeddedAgent`, and `updateSessionStore`.

## Tests added/changed

- `src/agents/subagent-announce.continuation-drain.test.ts`: mixed bracket+tool ordering, max-chain accounting, required-write child/parent persistence assertions.
- `src/auto-reply/continuation/delegate-dispatch.test.ts`: fail-closed store-load recovery for pending and post-compaction rows.
- `src/auto-reply/continuation/post-compaction-release.test.ts`: accepted-only post-compaction finalization.
- `src/agents/embedded-agent-runner/run.continuation-opts-forward.test.ts`: common embedded-run budget reset.
- `src/agents/subagent-session-cleanup.test.ts` and `src/auto-reply/continuation-delegate-store.post-compaction-substrate.test.ts`: cleanup gating/log/retry coverage.

## Validation

Passed:

- `node scripts/run-vitest.mjs run --config test/vitest/vitest.auto-reply.config.ts --maxWorkers=1 src/auto-reply/continuation/delegate-dispatch.test.ts src/auto-reply/continuation/delegate-dispatch-post-compaction.test.ts src/auto-reply/continuation/post-compaction-release.test.ts src/auto-reply/continuation/delegate-mid-run-compaction-survival.test.ts src/auto-reply/continuation-delegate-store.post-compaction-substrate.test.ts` — 87 tests passed; substrate file was not selected by this shard.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-core.config.ts --maxWorkers=1 src/agents/subagent-announce.continuation-drain.test.ts src/agents/subagent-session-cleanup.test.ts` — 29 tests passed.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-embedded-agent.config.ts --maxWorkers=1 src/agents/embedded-agent-runner/run.continuation-opts-forward.test.ts` — 5 tests passed.
- `node scripts/run-vitest.mjs run --config test/vitest/vitest.auto-reply-reply.config.ts --maxWorkers=1 src/auto-reply/reply/post-compaction-delegate-dispatch.test.ts` — 34 tests passed.
- `node scripts/run-tsgo.mjs -p tsconfig.core.json`
- `node scripts/run-tsgo.mjs -p test/tsconfig/tsconfig.core.test.json --incremental --tsBuildInfoFile .artifacts/tsgo-cache/core-test.tsbuildinfo`
- `node_modules/.bin/oxfmt --check $(git diff --name-only HEAD^ HEAD)`
- `node_modules/.bin/oxlint $(git diff --name-only HEAD^ HEAD)`
- `git diff --check HEAD^ HEAD`

Full suite:

- `node scripts/test-projects.mjs` ran 89 shards in 679.46s and failed 6 shards.
- Touched-surface tests passed inside the full run; `vitest.agents-core` failed from `ERR_WORKER_OUT_OF_MEMORY` after 5,738 passing tests in the full run and after 5,665 passing tests in a serial rerun.
- Other failing shards appear unrelated to this lane: `gateway-server` (`server-reload-handlers.test.ts` deferred reload assertion), `extension-qa` (Crabline manifest/channel env failures), `extension-mattermost` (command action button rendering expectation), `cli` (`logs-cli.test.ts`, `run-main.exit.test.ts`), and `extension-codex-app-server-support` (`session-history.test.ts` continuation/leaf history expectations).

## Readiness

Branch `codeagent/1159-review-findings-fix` is code-ready for #1159 fast-forward from this lane’s touched-surface evidence, with full-suite failures classified as unrelated/baseline or runner OOM rather than caused by these continuation changes.
