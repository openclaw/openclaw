# Cold turn attribution

## Acceptance rule

Use the frozen synthetic Gateway workload over its real WebSocket transport.
Attribute every statement and worker request in `02.first-turn`,
`10.restart-first-turn`, and `06.cron` to its operation, owner, and call site.
Run three fresh fixtures on the same current-main build with the read-only
v3.1.5 observer. Compare each cold phase with the ten warm turns' operation medians;
keep execution-window and causal counts separate. Report repetitions within each
turn, main-thread SQL, and statements without a worker request explicitly.

Only remove work whose owning contract shows it is redundant. Exclude transcript
identity folding, session preparation hydration, pending-input recovery, session
creation and subagent owners, and cron health reads. Preserve security checks at
their effects, ordered cross-store commits, and cron crash/recovery receipts.

For each candidate, use three alternating same-platform baseline/candidate pairs
with the frozen workload. Report statements, requests, and main-thread medians
and ranges by phase and operation, including warm non-regression. Touched owners
must perform less work; first and warm turns must not increase. Any main-thread
increase or a 20% regression in a user-facing metric stops the change. Reject
candidates that do not save measured work. No schema changes or new caches are
part of this experiment.

Counts and profiles do not establish latency. Timing comparisons require the
campaign timing lock, load below 24, and at least five interleaved samples per arm,
with cold and warm results separate and median, p95, and spread reported. Without
those conditions, report counts and CPU profiles only and state the timing gap.
