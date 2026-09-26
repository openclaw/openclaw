# Subagent workflow recipes

Choose the current harness's supported delegation tools. For OpenClaw workers,
use announcing `sessions_spawn` runs for a few children or `collect: true` plus
`agents_wait` for a larger batch. Discover the enabled tool schemas before
building calls. This file adds no tools and grants no permission to launch work,
change files, or publish results.

## Research or review, then reduce

Give each child a bounded question, relevant source paths, a completion condition,
and read-only scope. Ask for evidence locations and unresolved questions. Keep the
parent responsible for reconciling conflicting findings and final acceptance.

For a collector batch, start every accepted child once and retain its returned
`runId` and `childSessionKey`. Give each item a stable label, such as
`review-storage` or `review-recovery`; a label helps discovery but is not an
idempotency key. Drain `agents_wait` with only the remaining run IDs. A bounded
wait returning pending does not fail or cancel the child. Process completed and
failed items separately; a failed lane must not discard other accepted work.
Collector children do not announce and cannot be steered, so do not park them
behind `sessions_yield`. Use [the documented drain loop](https://docs.openclaw.ai/tools/swarm#use-swarm-from-other-harnesses).

Before reducing, ask each result: what was inspected, what is supported by direct
evidence, what failed, and what remains uncertain? Check the cited evidence.
Disagreement or a missing result should remain visible in the synthesis.

## Implement, verify, and hand back

Use an announcing child when the parent may need to steer or follow up. Give
independent writers separate worktrees or disjoint file ownership; name one
integration owner. Each child returns changed paths, proof run, failures, and
remaining work. A final message alone is not proof that its tool processes or
descendants have settled.

After implementation settles, run an independent verifier against the actual
artifacts and original acceptance condition. Supply requirements and evidence,
not the implementer's conclusion. Continue the existing child when new work
belongs to the same assignment; do not send a notification and assume an idle
child started another turn. Use the enabled control tool's explicit follow-up
operation and inspect its result.

Finish only after the requested outcome is verified. For example, a clean test
run does not prove a PR merged, and a ready child result does not prove delivery
to the parent.

## Resume from recorded facts

For managed Lobster workflows, retain the flow ID. In the owning session,
inspect the latest record with `openclaw tasks flow show <id> --json`. Review the
saved approval prompt and the user's actual decision, then call:

```json
{
  "action": "resume",
  "flowId": "<existing-flow-id>",
  "flowExpectedRevision": 4,
  "approve": true,
  "maxStdoutBytes": 8192
}
```

Replace `4` with the current revision. Omit `token` and `approvalId` to use the
checkpoint stored in that flow. A cancelled, finished, changed, missing, or
unrelated checkpoint must be reconciled before execution. Lobster's own saved
checkpoint must still exist; a TaskFlow record does not reconstruct it.

For subagent work, reconcile retained task/run IDs through owner-visible task
inspection or collector waits before dispatching anything again. Reuse a
completed result only when its input and acceptance condition still match.
If the launch was accepted but its receipt was lost, inspect existing children
and their task records; do not infer that no child exists from a missing local
variable. If association is uncertain, report it and avoid duplicate writes.

Plugin controllers keep bounded stage keys, input references, canonical child
IDs, result references, and acceptance state in managed TaskFlow `stateJson`.
After restart, reload from the existing SQLite owner and reconcile with current
task outcomes. Check every revision-bearing mutation. A recorded wait needs a
real event handler or automation to wake it. Neither this recipe nor TaskFlow
replays arbitrary JavaScript or uncertain external side effects. Linking a task
does not launch it; use the [requester-bound launch/link contract](https://docs.openclaw.ai/plugins/sdk-runtime/background-work).

## Optional shared-workspace coordination

When Workboard is installed and its tools are allowed, use one existing card
per agreed write scope. Record the repository/worktree, owned paths, task ID,
and handoff condition in its notes. All participating writers must use the same
card for an overlapping scope; two different cards do not conflict automatically.
Use a stable `idempotencyKey` when creating the card and retain the returned ID.

Before writing, call `workboard_claim` for that ID. Keep the returned token in
the controller's private tool context; do not copy it into card notes, worker
reports, or unrelated tasks. A refused claim means wait for the current writer
or choose an isolated worktree. Do not reclaim active work to bypass contention.
Refresh longer work with `workboard_heartbeat`, and reread the claim before
starting another write phase after a wait or restart.

Call `workboard_complete` with the actual result and proof when the assignment
has settled, or `workboard_block` with the concrete blocker. Use
`workboard_release` only for an intentional pause/handoff after write-capable
processes have stopped. A cancellation acknowledgment alone is insufficient.
Workboard owns claim expiry and recovery; avoid a second lease file or lock
database.

These claims coordinate cooperating agents. They are card-level claims scoped
to the calling agent, not filesystem locks or isolation between sessions of the
same agent. Shell commands and editors are not fenced by them. Use separate
worktrees when concurrent writes require isolation; keep checkout switching,
dependency installation, and integration under one owner. Without Workboard,
the parent can assign disjoint scopes and serialize shared writes directly.
Retain a failed worker's worktree and artifacts for inspection; cleanup follows
verified settlement and the task's ownership rules, not a generic error handler.
