# Durable Runtime Agent/Session Wiring PR Proof - 2026-07-01

## Scope

This proof covers the PR3 agent/session wiring slice stacked on the durable
runtime foundation PR.

The PR3 slice includes:

- gateway `chat.send` and `agent.run` correlation with durable runtime context
  refs;
- user-turn transcript propagation for durable context refs;
- embedded-agent yield progress for resumable parent turns;
- subagent child-run mirroring and parent fan-in association;
- task completion contract metadata needed for durable parent/child lifecycle;
- status-notice display metadata for durable/yield progress.

This slice does not include Work module, Workboard UI/tools, Task Flow
projection adapters, retention/compaction, or write controls.

## Dependency

This PR depends on the durable runtime foundation branch. Review PR2 first for
the `durable_runtime_*` schema, store, recovery, CLI, and read-only Gateway
inspection APIs.

## Validation Snapshot

Focused validation run before opening the PR:

```bash
node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts src/gateway/server-methods/durable.test.ts src/gateway/context-refs.test.ts src/gateway/server-methods/server-methods.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.agents-tools.config.ts src/agents/tools/sessions-spawn-tool.test.ts src/agents/tools/gateway-tool.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/agents/subagent-registry-lifecycle.test.ts src/agents/system-prompt.test.ts src/agents/embedded-agent-runner/run.empty-error-retry.test.ts src/tasks/task-completion-contract.test.ts src/tasks/task-executor-policy.test.ts src/sessions/user-turn-transcript.test.ts
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit.config.ts src/durable/fan-in.test.ts src/durable/subagent.test.ts src/durable/agent-turn.test.ts
```

Observed results:

- gateway/context/server-methods shard: 6 files, 176 tests passed;
- agent tools shard: 2 files, 67 tests passed;
- agent/session/task policy shard: 1 file, 27 tests passed;
- durable fan-in/subagent/agent-turn shard: 3 files, 14 tests passed.

## Final Proof To Add Before PR Submission

- `npm run tsgo:core`;
- `npm run tsgo:core:test`;
- `npm run build`;
- `git diff --check`;
- isolated enabled-runtime proof for parent yield, child fan-in, and restart
  inspection through `durable.coordination.get`.
