# Truthful Early Status Policy

## Goal

Define a channel-agnostic rule for when OpenClaw should emit an early visible status before the
final reply is ready.

The goal is not to maximize status frequency. The goal is to reduce uncertainty only when:

- the user has sent something that materially changes the handling of an active task
- the system is unlikely to show any other visible output quickly
- the status can remain fully truthful

## Scope

This policy governs the runtime decision boundary only.

- Runtime and delivery layers decide whether early truthful status is allowed.
- Channels such as Feishu, QQ, Telegram, and Slack only render or transport an already-approved
  status.
- Channel adapters must not infer visibility from internal block shape.

## Positive Rules

Early truthful status is allowed when all of the following are true:

- the turn is externally routable
- there is an active foreground run
- the turn is not a heartbeat/system self-check
- the queue/supervisor outcome represents a real user-visible change to the active task

In the current runtime, this means:

- `interrupt`
  The user replaced the current foreground task.

- `steer` or `steer-backlog`
  The user corrected or redirected the current task.

- `followup` or `collect`
  The user added material or constraints that should be absorbed into the current task.

## Negative Rules

Early truthful status should be suppressed when:

- the turn is non-routable/internal
- the turn is a heartbeat
- there is no active run to acknowledge
- the current behavior would overstate what runtime actually did

In the current runtime, this means:

- `queue` / defer
  We should not say "I will do this later" while the active-run path still foregrounds work
  immediately. That would be directionally plausible but not precise.

- `continue`
  Current trigger coverage is not stable enough to justify a visible status.

- late-stage delays after something is already visible
  If the dominant latency sits in `firstVisibleToFinal`, the system already reduced uncertainty.
  The next fix belongs in final delivery or long-tail execution, not in extra status messages.

## Observability Tie-In

The policy should be informed by latency evidence, especially:

- `runToFirstVisible`
- `firstEventToFirstVisible`
- `firstVisibleToFinal`

Interpretation:

- If dominant bottlenecks cluster in `runToFirstVisible` or `firstEventToFirstVisible`, the system
  should consider an early truthful status for eligible active-run transitions.
- If dominant bottlenecks cluster in `firstVisibleToFinal`, do not add more early status. Improve
  the final path instead.
- If dominant bottlenecks cluster before runtime start, prefer runtime or queue fixes over more
  user-facing messages.

This creates two distinct decisions:

- semantic allowance
  Is a truthful early status allowed at all for this kind of active-run transition?

- optimization priority
  Given recent latency patterns, should early truthful status be treated as a likely product win,
  or should we fix a different stage first?

Current recommendation mapping:

- `runToFirstVisible` / `firstEventToFirstVisible`
  Prioritize early truthful status work.

- `dispatchToQueue` / `queueToRun` / `acpEnsureToRun` / `runToFirstEvent`
  Observe and improve runtime or queue behavior first.

- `firstVisibleToFinal`
  Deprioritize additional early status. Users already got uncertainty reduction.

## Current Runtime Hook

The first runtime consumer of this policy is active-run queue handling in `runReplyAgent(...)`.

That hook should:

- use a pure policy helper
- preserve current behavior for `interrupt`, `steer`, `steer-backlog`, `followup`, and `collect`
- continue suppressing `queue` / defer and `continue`

## Non-Goals

- This policy does not authorize channel-specific block streaming to users.
- This policy does not yet enable defer/continue status.
- This policy does not guarantee a status will be sent; it only defines when sending one is
  semantically allowed.
