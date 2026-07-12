---
title: Durable Core PR2 Exact-Head Proof
summary: "Inspectable proof pack for PR2 durable runtime core at the reviewed runtime head."
read_when:
  - Reviewing PR2 durable runtime proof
  - Auditing ClawSweeper durable-core scenario coverage
  - Checking exact-head durable runtime evidence
---

# Durable Core PR2 Exact-Head Proof

## Scope

This proof pack covers PR2, [openclaw/openclaw#104327](https://github.com/openclaw/openclaw/pull/104327),
for the durable runtime core foundation.

Runtime head under test:
`949af487d8e90c84357657327de4df902194f549`

Proof recorded:
`2026-07-12T11:11:10Z`

The proof-pack commit that adds this file is docs-only. Runtime, schema,
Gateway, command, channel, protocol, and generated client behavior are unchanged
from the runtime head above.

## Boundary

PR2 adds the opt-in durable runtime foundation:

- shared `state/openclaw.sqlite` durable runtime tables;
- Kysely-backed durable store lifecycle over the shared state DB;
- run, step, event, ref, link, timer, signal, lease, recovery, fan-in, and
  result-mailbox primitives;
- read-only CLI and Gateway inspection;
- bounded agent, chat, subagent, and channel handoff facts;
- default-off runtime and separately gated worker behavior.

PR2 does not claim default-on behavior, arbitrary replay, exactly-once external
delivery, Workboard UI, Task Flow authoring, or external transport delivery
guarantees. Delivery proof below covers the PR2 internal durable handoff and
delivery-state semantics only.

## Live PR Status

Live check query:

```bash
gh pr checks 104327 --repo openclaw/openclaw \
  --json name,state,startedAt,completedAt,link \
  --jq '[.[] | select(.state != "SUCCESS" and .state != "SKIPPED" and .state != "CANCELLED") ]'
```

Output:

```json
[]
```

Interpretation: no live PR checks were reported in a non-success, non-skipped,
non-cancelled state at the time of this proof refresh.

## Remote Proof Availability

Preferred remote Testbox proof was attempted first:

```bash
node scripts/crabbox-wrapper.mjs warmup \
  --provider blacksmith-testbox \
  --keep \
  --timing-json
```

Result:

```text
[crabbox] provider=blacksmith-testbox explicit; if Testbox is queued or down, rerun without --provider to use .crabbox.yaml
[crabbox] delegated Testbox proof uses the wrapper exitCode and timing JSON; the linked Actions run can show cancelled during external lease cleanup
blacksmith testbox warmup failed: blacksmith failed: exec: "blacksmith": executable file not found in $PATH; if the delegated queue is unavailable, rerun with a coordinator-backed provider such as --provider aws
```

Because the delegated Testbox binary was unavailable in this environment, the
scenario proof used the narrow Codex-worktree fallback harness:
`node scripts/run-vitest.mjs`.

## Focused Scenario Transcript

Command:

```bash
node scripts/run-vitest.mjs \
  src/durable \
  src/state/openclaw-state-db.test.ts \
  src/commands/durable.test.ts \
  src/gateway/server-methods/durable.test.ts \
  src/channels/turn/durable-delivery.test.ts \
  src/channels/message/durable-receive.test.ts
```

Output excerpt:

```text
[test] starting test/vitest/vitest.unit.config.ts

 Test Files  17 passed (17)
      Tests  95 passed | 1 skipped (96)
   Duration  10.20s

[test] starting test/vitest/vitest.gateway.config.ts

 Test Files  2 passed (2)
      Tests  8 passed (8)
   Duration  1.08s

[test] starting test/vitest/vitest.commands.config.ts

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  741ms

[test] starting test/vitest/vitest.channels.config.ts

 Test Files  2 passed (2)
      Tests  13 passed (13)
   Duration  1.48s

[test] passed 4 Vitest shards in 28.93s
```

Total focused proof: 22 test files passed, 123 tests passed, 1 test skipped.

## Scenario Coverage

| ClawSweeper scenario | Exact-head evidence | Coverage |
| --- | --- | --- |
| Fresh install/default-off | `src/commands/durable.test.ts` covers disabled CLI stats and JSON status without creating or migrating durable state. `src/gateway/server-methods/durable.test.ts` covers disabled Gateway inspection rejecting before durable state creation. `src/durable/recovery.test.ts` covers worker not starting without explicit worker flag. | Covered for CLI, Gateway, and worker default-off paths. |
| Upgrade/existing shared DB/schema behavior | `src/durable/sqlite-store.test.ts` covers opening a pre-durable shared state DB without touching existing rows. `src/state/openclaw-state-db.test.ts` covers creating durable runtime tables as part of the shared schema, preserving existing rows when shared state adds durable runtime schema, and refusing newer shared schema versions. `src/commands/durable.test.ts` and `src/gateway/server-methods/durable.test.ts` cover future-schema safe errors without durable mutation. | Covered for additive shared schema, existing row preservation, future schema fail-closed behavior, and disabled existing-DB no-migration behavior. |
| Close/reopen | `src/state/openclaw-state-db.test.ts` covers durable writes persisting across explicit close and reopen, and deferring close requests until the explicit durable write lease is released. `src/durable/recovery.test.ts` covers persisted running agent turns being marked lost after the store is reopened. | Covered for shared DB handle close/reopen, lease-protected close, and reopened-store recovery classification. |
| Restart/recovery | `src/durable/recovery.test.ts` covers gateway-startup loss marking for running agent turns, chat.send frontdoors, and subagent runs; periodic stale recovery; due timer reconciliation; and signal resume. `src/durable/executor.test.ts` covers stale worker ownership rejection and side-effect uncertainty fail-closed behavior. | Covered for restart recovery, stale lease recovery, no-handler/side-effect uncertainty, and worker-gated mutation. |
| Fan-in | `src/durable/fan-in.test.ts`, `src/durable/fan-in-snapshot.test.ts`, `src/durable/subagent.test.ts`, `src/durable/coordination-projection.test.ts`, and `src/commands/durable.test.ts` cover parent/child links, fan-in readiness, result mailbox diagnostics, coordination projections, and CLI output including fan-in and delivery status. | Covered for durable parent/child links, fan-in readiness, snapshot/projection, and inspectable CLI diagnostics. |
| Delivery behavior | `src/channels/turn/durable-delivery.test.ts` covers default best-effort final delivery, required unknown-send reconciliation, and partial send failure reporting. `src/channels/message/durable-receive.test.ts` covers durable receive behavior. `src/durable/result-mailbox.ts` is exercised through durable command and fan-in diagnostics. | Covered for PR2 internal delivery-state semantics. External transport delivery is not claimed by PR2. |

## Architecture And Contract Notes

- Durable runtime remains opt-in through `OPENCLAW_DURABLE_RUNTIME`.
- Recovery worker mutation remains separately gated through
  `OPENCLAW_DURABLE_WORKER`.
- Disabled CLI and Gateway inspection paths are expected to fail with guidance
  before creating SQLite files or durable tables.
- Durable state belongs to the shared state DB owner and is accessed through the
  shared Kysely-backed state boundary.
- Future shared-state schema versions fail closed before durable mutation.
- Internal handoff and delivery evidence are durable runtime facts; external
  transport delivery requires separate direct implementation and proof.

## Additional Command Notes

`pnpm docs:list` was attempted because this is docs work, but in this linked
worktree it entered dependency reconciliation and optional package fetch retries.
The command was stopped before completion after package fetch retries began. No
tracked files changed.

```text
[WARN] GET https://registry.npmjs.org/@zed-industries/codex-acp-darwin-x64/-/codex-acp-darwin-x64-0.16.0.tgz error (23). Will retry in 10 seconds. 2 retries left.
[WARN] GET https://registry.npmjs.org/@openai/codex/-/codex-0.144.1-darwin-x64.tgz error (23). Will retry in 10 seconds. 2 retries left.
[ERROR] Command was killed with SIGINT (User interruption with CTRL-C): ... pnpm install
```

## Remaining Gaps

- Maintainer sponsorship is still required for the new persistent schema,
  environment controls, CLI/Gateway protocol, and generated native-client
  contract.
- This proof does not claim external channel exactly-once delivery or external
  transport delivery guarantees beyond the PR2 internal durable delivery-state
  boundary.
- Remote Testbox proof was blocked by missing local `blacksmith` executable in
  this environment; exact-head local fallback proof is recorded above.
