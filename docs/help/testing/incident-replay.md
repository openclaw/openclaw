---
summary: "Opt-in replay of a reported failure through an isolated built Gateway"
title: "Incident replay trial"
read_when:
  - Qualifying the incident replay check against a repair or clean control
---

Run the initial, opt-in incident replay from a prepared source checkout:

```bash
pnpm test:incident-replay
```

This is not part of the default test suite or a required CI check. It does not
change the history test or existing user behavior. Measure hosted CI cost before
adding it to required checks or expanding the scenario inventory.

## One scenario

[Issue #201581](https://github.com/openclaw/openclaw/issues/201581) reported that
ordinary feature-operation errors reached callers only as a generic failure.
The report-derived scenario was frozen before inspecting
[repair #197265](https://github.com/openclaw/openclaw/pull/197265).
It starts a real isolated Gateway, loads a fixture through the public feature SDK,
qualifies dispatch with a successful sibling operation, then calls an operation
that throws
`Error("Choose a project first.")` through authenticated
`plugins.sessionAction`. Only the caller's response is the behavioral oracle.
No external provider, credentials, or live user state are needed.

The existing feature-session-action suite owns scope, validation, typed-client,
and bounded-error contracts. This optional replay adds the distinct built-runtime
and external-plugin loading boundary across revisions. It does not copy that
suite's contract matrix or claim UI, reconnect, cancel, or restart coverage.

The scenario file is deliberately not named `*.test.ts`. The runner stages an
unchanged copy in the target checkout for the existing E2E runner, then removes
that copy. Existing Gateway fixtures own isolated state, ports, and teardown.

## Compare revisions

Prepare trusted, separate linked worktrees with private dependencies using the
normal repository checkout workflow. Do not switch a checkout another job uses.
The replay runner never fetches source, installs dependencies, or changes refs.
Run the same runner and scenario on both revisions:

```bash
pnpm test:incident-replay --checkout /path/to/pre-fix-checkout \
  --revision 7154e4efb11bf33fdd7b9fc4ccbe3333f0bcf585
pnpm test:incident-replay --checkout /path/to/fix-checkout \
  --revision e89431f17eec09cf12a93a20765e4e89cf258be1
```

An explicit revision requires that exact HEAD and unchanged tracked source.
Use fresh, built artifacts for each revision; the canonical test runner prepares
its normal E2E prerequisites. Never copy another revision's build output.

The printed output directory contains the command log, Gateway log, caller
responses, Vitest report, and receipt. The receipt binds the source revision,
local tracked patch hash (if any), runner/scenario hashes, elapsed command time,
observations, and cleanup result. Scenario wall time includes Gateway startup
and teardown; command time also includes test/build preparation. Dependency
installation is separate. `--output` selects a new directory under an existing
parent; reusing an output directory is refused.

Exit 0 means pass. Exit 1 means the reported behavioral assertion failed after
readiness and successful sibling dispatch. Exit 2 means no qualified result,
including setup failure, interrupted execution, missing/skipped tests, changed
inputs, or failed cleanup. Do not count exit 2 as a regression catch or false
alarm. Keep failed attempts visible rather than selecting a green retry.

A qualified red/green pair requires identical runner/scenario hashes, unchanged
source at the exact repair parent and repair, a behavioral failure before the
repair, and a pass after it. Compare each clean-control PR's parent and head
with that same scenario, reusing a shared revision only when inputs match.
A control alarm needs causal review; a failing control parent is not a new alarm.

For future enrollment, write the behavior and executable from the bug report
before inspecting its repair. Record the report URL, freeze time, and scenario
hash. Do not tune the frozen oracle after seeing the repair. A scenario that does
not reproduce is an unsuccessful candidate, not evidence of detection.

Remove completed comparison worktrees through Git after checking their jobs have
exited. Keep receipts needed for review; remove generated run directories when
that proof is no longer needed.
