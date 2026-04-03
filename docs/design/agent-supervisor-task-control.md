# Agent Supervisor and Task Control Design

## Overview

This document defines a supervisor layer above the current queue arbitration
logic. The goal is to move OpenClaw from a message-only arbitration model to a
task-aware execution model that can reason about active work, interruptibility,
and event-driven control flow.

The current runtime already has strong low-level building blocks:

- session-scoped active runs in `src/auto-reply/reply/get-reply-run.ts`
- run execution in `src/auto-reply/reply/agent-runner.ts`
- fast abort and queue clearing in `src/auto-reply/reply/abort.ts`
- stale reply suppression via session generation in
  `src/auto-reply/reply/dispatch-from-config.ts`

What is missing is a higher-level component that answers:

- What task is currently in the foreground?
- Is the current task in a phase that may be interrupted?
- How does a new event relate to the current task?
- Should the system continue, steer, append, pause, fork, abort, or defer?

This document is intentionally written before implementation. It is meant to
set a stable boundary for later code changes and review.

## Implementation Status

The first runtime skeleton has already been landed:

- runtime taxonomy payload:
  `src/auto-reply/reply/supervisor/taxonomy.v1.json`
- runtime taxonomy loader:
  `src/auto-reply/reply/supervisor/taxonomy.ts`
- initial runtime helpers:
  - `event-normalization.ts`
  - `task-state.ts`
  - `pre-route.ts`
  - `translate.ts`
  - `decision-record.ts`
  - `outcome-record.ts`
  - `classify.ts`
- first seam insertion:
  `src/auto-reply/reply/get-reply-run.ts`

This first increment is intentionally conservative. It does not yet let the
supervisor override queue behavior. It only establishes:

- a machine-loadable taxonomy
- a typed runtime home for supervisor concepts
- a first append-only decision-record pipeline
- a first append-only outcome-record pipeline
- a first weak-supervision signal path via `user_corrected`
- a classifier boundary that now supports a local relation model while still
  falling back to legacy queue translation
- a stable seam where richer supervisor policy can be added next

## Problem Statement

Today, OpenClaw mostly behaves like a single active conversational run per
session lane. That is sufficient for simple chat steering, but it is not a
complete task control model.

Current queue arbitration is centered on classifying inbound user updates as:

- `interrupt`
- `steer`
- `collect`

That model is useful, but it is too narrow for agent-task execution. In
practice, the system also needs to reason about:

- whether an active task exists at all
- which phase the active task is in
- whether the current phase is physically safe to interrupt
- whether a new event should modify the current task or create a new one
- whether a side task should be deferred instead of immediately taking focus

Without an explicit supervisor layer, queue arbitration is forced to absorb
responsibilities that do not belong to a message classifier.

## Goals

- Define a task-aware supervisor layer that sits above current queue
  arbitration.
- Keep low-level runtime correctness deterministic.
- Leave complex semantic decisions to a model-driven policy layer where
  appropriate.
- Support future evolution toward richer task management without requiring a
  full runtime rewrite.
- Preserve the current OpenClaw philosophy: simple framework guarantees,
  flexible model-driven behavior.

## Non-Goals

- This document does not redesign the full agent runtime.
- This document does not require true parallel tool execution in the first
  phase.
- This document does not define a reinforcement-learning pipeline.
- This document does not replace existing queue arbitration immediately.

## Design Principles

### 1. Physical safety belongs to the framework

The framework should own deterministic guarantees around:

- short atomic state transitions
- queue clearing and active run switching
- session generation changes
- commit-like persistence boundaries
- delivery guards and stale output suppression

These behaviors should remain model-independent.

### 2. Task semantics belong to the supervisor

Questions such as:

- should a task continue?
- should a new input fork a side task?
- should the current task stay in the foreground?

are semantic decisions. They should be handled by a task-aware supervisor, not
hard-coded deep in the runtime.

### 3. Complex judgments should remain model-friendly

OpenClaw should not overfit framework rules for decisions that are inherently
contextual. The system should prefer:

- deterministic runtime guards for correctness
- structured context and retrieval for semantics
- a lightweight model for ambiguous decisions

### 4. Events, not only messages

The supervisor must process events, not just inbound message text. User
messages are only one instance of a broader event stream.

### 5. Fast feedback and accurate judgment are different problems

The system should separate:

- fast user-visible acknowledgement
- slower but higher-quality task and relation judgment

For a consumer-facing experience, "I received this" should usually happen
within about one second, and ideally closer to half a second. That signal does
not need to wait for deep task arbitration to finish.

The first visible feedback should therefore be treated as a presentation-layer
response, not as proof that the supervisor has fully resolved the task/action
decision.

### 6. Do not confuse temporary guardrails with permanent runtime design

Some logic belongs in the runtime forever. Some logic only exists because the
current local relation model is not good enough yet.

This distinction should stay explicit so the project does not grow a permanent
maze of model workarounds.

The intended split is:

- runtime invariants:
  deterministic correctness and safety boundaries that should remain even if
  the model becomes much better
- temporary guardrails:
  narrow quality protections that prevent obviously invalid model outputs while
  the relation model is still immature
- model-owned policy:
  nuanced semantic and task-yield decisions that should move toward the model
  over time

## Current Runtime Baseline

The current implementation already contains most of the low-level machinery the
supervisor will rely on.

### Active run and queue state

`src/auto-reply/reply/get-reply-run.ts` inspects:

- whether an embedded run is active
- whether that run is currently streaming
- queue size and queue mode
- rule-based arbitration
- optional model arbitration for ambiguous cases

### Run execution

`src/auto-reply/reply/agent-runner.ts` already has meaningful run-time phases,
even if they are implicit rather than first-class:

- initial turn setup
- memory flush
- queue handling
- followup execution
- block streaming
- tool-result emission
- session usage persistence

### Abort behavior

`src/auto-reply/reply/abort.ts` provides deterministic abort handling:

- trigger recognition
- queue clearing
- active run termination
- abort memory

### Stale reply suppression

`src/auto-reply/reply/dispatch-from-config.ts` uses session generation to ensure
old output does not leak after a new turn supersedes the current one.

These pieces are sufficient to support a supervisor layer without replacing the
runtime foundation.

## Proposed Model

The proposed architecture has three cooperating layers:

- `Agent Supervisor`
- `Conversation Arbitrator`
- `Conversation Presentation Layer`

### Agent Supervisor

The supervisor owns:

- foreground task tracking
- task phase tracking
- interruptibility assessment
- event-to-action dispatch

It should answer:

- Does an active task exist?
- What phase is it in?
- Is the current phase physically interruptible?
- What is the relationship between the new event and the current task?
- What action should the runtime take next?

### Conversation Arbitrator

The arbitrator becomes a submodule of the supervisor. It is still useful, but
its job becomes narrower:

- classify message-to-task relationship
- distinguish correction vs supplement vs replacement
- resolve ambiguous conversational intent

The existing `interrupt / steer / collect` logic should be treated as a current
transport-level action vocabulary, not the final supervisor language.

### Conversation Presentation Layer

The conversation presentation layer is responsible for translating internal
agent state into a calm, legible user experience.

It should answer:

- What should the user see immediately?
- Which internal transitions deserve visible staged feedback?
- Which internal transitions should stay hidden?
- How should intermediate feedback be phrased, paced, grouped, or suppressed?

This layer should not own task semantics. It should consume decisions and
state from the supervisor and decide how much of that should be surfaced to the
consumer.

In practice, this creates two core pillars for the consumer experience:

- input influence:
  how the user's new event changes task direction, scope, constraints, or
  priority
- output presentation:
  how the agent's internal process is translated into reassuring, useful,
  non-noisy interaction

The first pillar is primarily the supervisor/arbitrator problem. The second
pillar is primarily the conversation presentation layer problem.

## Ownership Boundaries

The implementation should explicitly classify decision logic into three
ownership buckets.

### Runtime invariants

These are not workarounds. They are long-term framework responsibilities:

- short atomic state transitions
- session generation and stale suppression
- queue clearing and active run switching
- event normalization
- taxonomy loading and versioning
- decision and outcome recording
- timeout, fallback, and circuit-breaker behavior

Even a much stronger model should not replace these.

### Temporary guardrails

These are narrow protections that exist to keep poor model outputs from
producing obviously broken runtime decisions.

Examples:

- rejecting impossible same-task relations when the task state is clearly idle
- short-lived prompt shaping that compensates for model-specific quirks
- conservative fallback to legacy translation when a model times out or emits
  invalid output

These should be documented as transitional behavior and revisited as the model
improves.

### Model-owned policy

These are the parts of the system that are fundamentally semantic and should
trend toward model ownership:

- supplement vs correction
- replace vs parallel
- whether a side question should interrupt now or defer
- whether a foreground task should keep focus
- whether a user event changes task identity or only task execution

The long-term goal is not to write more clever guardrails, but to move these
judgments into a better relation/task policy model while keeping runtime
correctness fixed.

## Consumer Feedback Model

The supervisor design should also support a user-facing feedback model, but the
feedback itself should be planned and emitted by the conversation presentation
layer. From a consumer perspective, the system should not only be correct. It
should also feel responsive, legible, and calm.

The first iteration should think in terms of at least four user-visible layers:

- received:
  a fast acknowledgement that the system has noticed the new event; typing
  indicators fit here
- working:
  a lightweight signal that active reasoning, routing, or execution is under
  way
- staged progress:
  selective intermediate output or milestone signals when they improve
  confidence or reduce waiting anxiety
- final outcome:
  the completed reply, decision, result, or deferred handoff

Not every phase should always be shown. Some intermediate state should remain
internal. The design goal is to reveal the parts that improve trust and reduce
confusion, while hiding noisy internal churn.

This implies a useful product rule:

- fast acknowledgement should be cheap and near-immediate
- richer staged feedback should appear only when it improves the experience
- some phases should be intentionally collapsed so the user sees a cleaner
  narrative than the raw internal state machine

This area is important but not urgent. The runtime supervisor should therefore
be designed so user-facing feedback can later be layered on top without
rewriting the underlying task and relation model.

## Display Message Production

The system should treat visible intermediate messages as a separate production
problem rather than as a direct dump of internal state.

At least three producer types are likely needed:

- system-produced status messages:
  fast, deterministic signals such as received, waiting for approval, paused,
  resumed, or deferred
- model-produced process narration:
  concise natural-language updates that explain what the agent is doing at a
  high level when that explanation is genuinely helpful
- task-produced intermediate artifacts:
  real partial results, drafts, outlines, findings, or milestone outputs that
  are worth surfacing

Visible messages should therefore be derived from internal state, not copied
from it. A useful mental model is:

- internal events happen
- the supervisor decides what they mean for task control
- the conversation presentation layer decides whether any user-visible message
  should be produced
- a display message planner selects the message class, pacing, and phrasing

This lets the system reveal meaningful progress without exposing raw runtime
churn.

### Milestone model input draft

`milestone` should not jump directly from internal state to user-visible text.
There should be an explicit planner-layer contract in between.

The planner should therefore be allowed to emit a `milestone` model input
draft, even when no `milestone` message is actually shown.

The purpose of this draft is:

- preserve the semantic reason a milestone would exist
- separate "should we show this?" from "how should it be worded?"
- keep milestone wording as an optional enhancement rather than a runtime
  dependency

A useful first shape is:

- `audience_question`
  the user concern the milestone would answer
- `semantic_role`
  what kind of intermediate understanding the milestone should provide
- `prompt_hint`
  lightweight guidance for future model wording
- `suppress_reason`
  why the milestone is currently not being surfaced, when applicable

This draft is not itself a visible message. It is planner output.

That distinction matters:

- planner output:
  a semantic contract for later wording or suppression
- runtime output:
  an actual user-visible `milestone` message

This lets the system keep a stable milestone interface without forcing a model
call on every turn.

## Action to Presentation Defaults

The conversation presentation layer should be channel-agnostic by default. It
should not derive presentation strategy from output length alone. It should
primarily derive presentation strategy from supervisor action and current task
mode.

This is important because length only describes generation cost. It does not
describe what the user most needs to understand.

### Presentation classes

A minimal first presentation vocabulary is:

- `ack`
- `status`
- `milestone`
- `final`

Interpretation:

- `ack`:
  near-immediate confirmation that the event was received
- `status`:
  a high-level explanation of what is being done or how control changed
- `milestone`:
  a meaningful intermediate update that is worth surfacing, whether it is
  framed as progress or as a partial result
- `final`:
  the completed reply, handoff, or terminal outcome

### Experience modes

Not every turn should use every presentation class. A useful first split is:

- `quick_turn`:
  usually `ack -> final`
- `guided_turn`:
  often `ack -> status -> final`
- `work_turn`:
  may use `ack -> status -> milestone -> final`

The conversation presentation layer should prefer a mode based on task
complexity, expected latency, and supervisor action rather than on message
length alone.

### Default mapping by supervisor action

The first default mapping should look like this.

### User-visible semantic boundary table

The presentation layer should not only decide whether something is shown. It
should also keep a stable semantic contract for what each action means to the
user.

The practical boundary is:

| Supervisor action   | User-visible question being answered                                | `status` semantic role                                                                      | `milestone` semantic role                                                                                                | Usually suppress when                                                                                                          |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `append`            | "Did you absorb my new constraint or material?"                     | Confirm that the new detail was folded into the current task without changing task identity | Show only if the added material causes a meaningful visible shift in the work product                                    | The turn is very fast, the append is trivial, or the added detail does not change visible work                                 |
| `steer`             | "Did you actually change direction based on my correction?"         | Confirm that the current task was re-aimed or reinterpreted                                 | Show only if the correction causes a noticeable reset, narrowed scope, or newly useful intermediate result               | The correction is minor, the task is about to finish, or the redirect is already obvious from the final reply                  |
| `abort_and_replace` | "Did you drop the old task and switch focus?"                       | Confirm that the old foreground task was abandoned and the new one now owns focus           | Show only if the replacement task is long enough or produces an intermediate finding worth surfacing                     | The replacement is near-instant or the final reply will make the switch obvious immediately                                    |
| `pause_and_fork`    | "Did you preserve the current task while opening a side branch?"    | Confirm that a side task became foreground while the current task stays resumable           | Show when the forked branch reaches a meaningful checkpoint or produces a useful early result                            | The fork resolves almost immediately or the branch does not create user-visible uncertainty                                    |
| `defer`             | "Did you intentionally keep this for later instead of ignoring it?" | Confirm that the new event was captured but intentionally not foregrounded yet              | Usually none; if anything is shown, it should be rare and only when defer state itself becomes materially useful context | There is no active foreground task, the system is already waiting, or the deferred item does not compete for current attention |

This table implies a stable split:

- `status` explains task-control effect
- `milestone` explains meaningful intermediate progress
- silence is preferred when neither explanation would reduce confusion

The user should therefore be able to infer:

- `append`:
  "my new detail was absorbed"
- `steer`:
  "my correction changed the direction"
- `abort_and_replace`:
  "the old task was dropped and replaced"
- `pause_and_fork`:
  "the current task was kept, but a side branch was opened"
- `defer`:
  "this was remembered, but not foregrounded now"

#### `continue`

Default stance:

- show `ack` if the user needs confirmation that the new event was seen
- avoid extra `status` unless the task is long-running or user confidence would
  otherwise drop
- allow `milestone` only when something genuinely worth surfacing exists

Rationale:

- the foreground task is still correct
- extra explanation is often unnecessary

#### `append`

Default stance:

- show `ack`
- allow a light `status` only when it helps the user understand that the new
  detail was absorbed into the current task
- do not show `milestone` unless the append materially changes the visible work

Rationale:

- the user added material, but did not ask for a task-control transition
- the calm default is to absorb the addition without ceremony

#### `steer`

Default stance:

- show `ack`
- often show a light `status` acknowledging the direction change
- allow `milestone` if the correction causes a meaningful visible reset,
  refocus, or partial result

Rationale:

- the user wants reassurance that the new direction was actually received

#### `pause_and_fork`

Default stance:

- show `ack`
- usually show `status`
- optionally show `milestone` if the forked task takes noticeable time or
  quickly yields something useful

Rationale:

- this is one of the most confusing task-control transitions if left invisible
- users often need to understand that the current task was preserved but a new
  foreground branch was created

#### `abort_and_replace`

Default stance:

- show `ack`
- often show `status`
- show `milestone` only if the replacement task is long enough to warrant it
  or yields a useful partial result

Rationale:

- users benefit from knowing that the old task was dropped and a new one took
  over

#### `defer`

Default stance:

- show `ack`
- show `status` only when a real foreground task is being preserved and the
  user would otherwise be unsure whether the deferred event was captured
- suppress `milestone`

Rationale:

- the critical thing is not "what am I doing now" but "I did not ignore your
  event"
- the user should understand that the event was captured and intentionally
  delayed

### Display policy principles

These defaults should be treated as channel-agnostic presentation policy.

Channels may later adapt:

- modality
- pacing
- animation
- wording
- layout

But they should not reinvent task-control semantics from scratch.

This gives the system a stable cross-channel rule:

- the supervisor decides what changed in task control
- the conversation presentation layer decides what the user should feel and see
- the channel decides how to render that presentation in its native surface

### Production philosophy

The framework should keep internal state concrete and lightweight:

- real task phase changes
- real tool results
- real task completions
- real approvals, pauses, resumes, and deferrals

The framework should not over-engineer semantic subtypes for user-facing
intermediate output. In particular, it should avoid forcing a rigid split
between "progress" and "artifact" if that split mainly exists for internal
engineering convenience.

Instead, the system should let the model decide how to express meaningful
intermediate state as a `milestone`, subject to lightweight runtime guards.

### Fast feedback vs rich expression

Not all user-visible messages require the same latency or the same model.

The system should allow at least two response speeds:

- fast reaction:
  cheap, near-reflexive acknowledgement such as typing indicators or short
  status hints
- rich expression:
  more thoughtful natural-language phrasing for milestones or task-control
  explanations

This creates room for a practical model split:

- a very fast local path for `ack` and simple `status`
- a slower but higher-quality path for milestone wording when worthwhile

The exact implementation can evolve. The important architectural rule is:

- keep runtime truth in the framework
- keep external wording lightweight and model-shaped
- do not force every visible message through the same latency budget

## Performance Requirements

Core runtime and presentation modules should declare explicit latency budgets.
This should be treated as a design input, not as a tuning detail discovered
only after deployment.

### Consumer-facing targets

The first presentation-oriented targets should be aggressive:

- `ack`
  - target: `<= 200ms`
  - hard ceiling: `<= 500ms`
- `status`
  - target: `<= 400ms`
  - hard ceiling: `<= 800ms`
- `milestone`
  - target: `<= 1500ms`
  - hard ceiling: `<= 3000ms`

`final` should remain task-dependent and is not given a single global budget.

### Latency classes

Each core module should declare a latency class:

- `reflex`
  - near-subconscious reactions such as `ack`
- `interactive`
  - low-latency task-control or presentation decisions
- `deliberative`
  - richer wording or full task execution that can tolerate more latency

The first mapping should be:

- `ack`: `reflex`
- simple `status`: `reflex` or `interactive`
- relation classification: `interactive`
- milestone phrasing: `interactive` or light `deliberative`
- final answer generation: `deliberative`

### Model guidance

These budgets imply strong default model guidance:

- `ack` should avoid model use whenever possible
- `status` should prefer templates or a very fast local path
- relation classification should prefer a small, fast, low-temperature local
  model with short outputs and reasoning disabled
- milestone wording may use a better model path when the extra quality is worth
  the delay
- final output may use the primary task model

The framework should not assume a single model path for all visible output.

## Adaptive Runtime Profile

The runtime should maintain an adaptive runtime profile rather than a single
static operating mode.

The adaptive runtime profile is the mechanism that decides how aggressive or
conservative the system should currently be about:

- which presentation model path to use
- whether milestone wording should stay enabled
- when to fall back to templates
- when to shorten outputs
- when to prefer stability over richness

### Heartbeat role

Heartbeat should not only prove that the system is alive. It should also serve
as the lightweight observer that updates the adaptive runtime profile.

Heartbeat should periodically inspect:

- actual `ack/status/milestone` latency
- timeout rate
- fallback rate
- model-specific failure patterns
- whether recent outputs are exceeding their declared latency class

### Allowed adjustments

Heartbeat should not perform open-ended semantic reasoning. It should only
apply predefined adjustments, such as:

- switch to a lighter presentation model
- disable thinking/reasoning mode
- reduce output length budgets
- temporarily suppress milestone generation
- fall back from model phrasing to templates
- move into a more conservative interaction profile

### Design principle

This creates a clean split:

- the supervisor decides what task-control change happened
- the conversation presentation layer decides what should be surfaced
- the adaptive runtime profile decides how aggressively the system can afford to
  surface it right now

Heartbeat is therefore not just a keepalive mechanism. It is the observer and
maintenance loop for adaptive interaction quality.

### Initial profiles

The first adaptive runtime profile should expose three operating modes:

- `aggressive`
- `balanced`
- `conservative`

#### `aggressive`

Intent:

- maximize perceived responsiveness and process visibility

Default behavior:

- keep `ack` extremely fast
- emit `status` more readily
- allow `milestone` more often
- prefer richer local model phrasing when budgets permit
- tolerate somewhat more visible process narration

Tradeoff:

- more expressive and lively
- more sensitive to model instability or latency spikes

#### `balanced`

Intent:

- default operating mode for most healthy runtime conditions

Default behavior:

- guarantee fast `ack`
- emit `status` when it clearly improves comprehension
- keep `milestone` selective
- mix templates and model phrasing pragmatically

Tradeoff:

- good blend of calmness, speed, and clarity

#### `conservative`

Intent:

- prioritize stability and predictability over expressive richness

Default behavior:

- keep `ack` fast
- prefer template-driven `status`
- suppress many optional `milestone` messages
- reduce wording complexity and output budgets
- fall back early when local model performance degrades

Tradeoff:

- quieter and less vivid
- more robust under pressure

### Profile effects

The profile should influence at least:

- whether optional `status` is emitted
- whether `milestone` is allowed at all
- whether model-generated phrasing is used
- output length and verbosity budgets
- fallback aggressiveness

This should be treated as a joint policy, not as a purely stylistic toggle.

### Escalation and downgrade rules

Heartbeat should adjust profiles conservatively upward and quickly downward.

Suggested first rule:

- downgrade quickly when:
  - latency budgets are exceeded repeatedly
  - timeout rate rises
  - fallback rate rises
  - a specific local model begins failing or stalling
- upgrade slowly when:
  - latency is stable
  - timeout rate stays low
  - fallback rate stays low
  - recent presentation quality remains acceptable

Operationally this means:

- enter `conservative` quickly
- return to `balanced` carefully
- enter `aggressive` only after sustained healthy behavior

## Task State Model

The supervisor should model state along multiple axes instead of a single
`busy/idle` flag.

### Execution Phase

Minimal first version:

- `idle`
- `planning`
- `acting`
- `committing`
- `waiting`

Interpretation:

- `idle`: no active task in the foreground
- `planning`: reasoning, decomposition, next-step selection
- `acting`: tool use or iterative execution
- `committing`: short atomic section where state/results are finalized
- `waiting`: blocked on user, tool completion, timer, or external signal

`committing` is the phase most likely to map to a hard physical no-interrupt
window.

### Interrupt Preference

Task-level hint:

- `free`
- `avoid`
- `critical`

Interpretation:

- `free`: easy to divert or replace
- `avoid`: default posture; do not disturb unless a stronger signal arrives
- `critical`: prefer to finish or stabilize current phase before switching

Default policy:

- task-level default should be `avoid`
- phase-specific logic may temporarily shift behavior
  - `waiting` often behaves closer to `free`
  - `committing` often behaves closer to `critical`

This preserves a stable assistant feel without making the runtime too rigid.

### Atomicity

Atomicity should remain a runtime concept, not a semantic one.

Two levels are sufficient initially:

- `interruptible`
- `atomic`

Only short physical transitions should be marked `atomic`.

Examples:

- updating session state
- persisting task outcome
- switching active generation tokens
- queue clear plus run replacement

Long semantic work should not be modeled as atomic by default.

## Event Taxonomy

The supervisor should consume normalized events, not only messages.

### User Events

- `user_message`
- `user_edit`
- `user_cancel`
- `user_approval`
- `user_rejection`

### Task Events

- `task_started`
- `task_phase_changed`
- `task_progress`
- `task_completed`
- `task_failed`
- `task_paused`
- `task_resumed`

### Tool Events

- `tool_call_started`
- `tool_call_completed`
- `tool_call_failed`
- `tool_requires_approval`
- `tool_result_arrived`

### Time and Schedule Events

- `timer_fired`
- `deadline_nearing`
- `scheduled_followup_due`
- `reminder_due`

### System and Channel Events

- `session_superseded`
- `channel_disconnected`
- `channel_restored`
- `delivery_failed`
- `memory_updated`
- `context_window_pressure`

## Event Schema

Minimal event shape:

```ts
type SupervisorEvent = {
  type: string;
  source: string;
  timestamp: number;
  payload: unknown;
  urgency: "low" | "normal" | "high";
  scope: "foreground" | "background" | "global";
  relatedTaskId?: string;
  relatedSessionId?: string;
};
```

Notes:

- `type` selects the handler path
- `urgency` helps determine whether the event can compete for foreground focus
- `scope` indicates whether the event should affect the active task, a background
  task, or the whole agent

## Relation Taxonomy

The supervisor should not map raw events directly to runtime actions. It should
first classify the relation between the incoming event and the current
foreground task.

This relation layer is the semantic middle layer between:

- raw events
- final supervisor actions

### Why a relation layer exists

The current queue arbitration labels (`interrupt / steer / collect`) are too
close to execution behavior. They do not preserve enough semantic information to
support richer task management.

A relation layer provides:

- a stable semantic label space
- a reviewable and testable interpretation standard
- a better target for retrieval examples and future model training

### Minimal first relation set

- `same_task_supplement`
- `same_task_correction`
- `same_task_control`
- `new_task_replace`
- `new_task_parallel`
- `background_relevant`
- `unrelated`

### same_task_supplement

Meaning:

- the event adds information to the current task
- the current task goal stays the same

Common signals:

- new constraints
- missing parameters
- extra context
- additional source material

Typical examples:

- "Budget cap is 3000."
- "One more constraint: it must work offline."
- "Supplement: they only accept English emails."

Common confusion boundary:

- may be confused with `same_task_correction`
- the key distinction is that supplement adds material, while correction changes
  the course or framing

### same_task_correction

Meaning:

- the current task is still valid
- the event changes direction, scope, or output shape inside the same task

Common signals:

- user corrects the assistant's interpretation
- user changes the emphasis or scope
- user changes the requested output format

Typical examples:

- "Not the full summary, only the last three days."
- "Focus on performance, not features."
- "Do not use a table; write it as three paragraphs."

Common confusion boundary:

- may be confused with `new_task_replace`
- the key distinction is that correction preserves the same task identity,
  whereas replace introduces a different foreground task

### same_task_control

Meaning:

- the event controls the lifecycle of the current task rather than its content

Common signals:

- pause
- continue
- cancel
- approve
- reject
- retry

Typical examples:

- "Stop for now."
- "Continue."
- "Use the previous version."
- "Approve this operation."

Common confusion boundary:

- may be confused with `same_task_correction`
- control changes task lifecycle or permissions; correction changes task content
  or direction

### new_task_replace

Meaning:

- the event introduces a stronger new foreground goal
- the current foreground task should stop yielding working memory priority

Common signals:

- explicit topic switch
- explicit replacement of the current objective
- urgent priority inversion

Typical examples:

- "Leave this for now and check the production error."
- "Different question: I want to ask about..."
- "Do not write the plan; send a reply first."

Common confusion boundary:

- may be confused with `new_task_parallel`
- replace means the old foreground task should yield; parallel means it should
  remain resumable

### new_task_parallel

Meaning:

- the event introduces a new task
- the current task still has enough value to preserve and resume later

Common signals:

- side question with independent work
- small inserted task
- follow-up request worth tracking separately

Typical examples:

- "Also check who owns this domain."
- "Open a small side task and translate this paragraph."
- "Keep this in mind; I will need a reminder later."

Common confusion boundary:

- may be confused with `background_relevant`
- parallel means create a resumable task; background means retain for later
  without foregrounding it immediately

### background_relevant

Meaning:

- the event is relevant to the broader context
- it should not immediately take foreground focus

Common signals:

- reminder-like content
- weakly related future work
- low-priority follow-up

Typical examples:

- "After this, remind me to contact them."
- "Keep this link for later."
- "We should revisit this after the meeting."

Common confusion boundary:

- may be confused with `unrelated`
- background-relevant content should still survive as a future candidate;
  unrelated content does not need to enter task control

### unrelated

Meaning:

- the event is not meaningfully connected to the current foreground task
- it also does not justify a new tracked task in the current context

Common signals:

- noise
- weak side remarks
- content with no clear task value

Typical examples:

- a random aside that does not imply action
- low-signal commentary unrelated to the foreground task

Common confusion boundary:

- may be confused with `background_relevant`
- the distinguishing question is whether the system should retain it as future
  work at all

## Pre-Routing and Decision Pipeline

The supervisor should not send every event directly into model judgment.
Instead, it should process each event through a staged decision pipeline.

### Stage 0: Event normalization

Convert raw runtime input into a normalized `SupervisorEvent`.

Examples:

- inbound chat payload -> `user_message`
- tool completion callback -> `tool_call_completed`
- timer callback -> `timer_fired`
- stale generation signal -> `session_superseded`

### Stage 1: Hard deterministic pre-routing

This stage handles events that should not require semantic interpretation.

Examples:

- explicit stop or cancel commands
- approval or rejection events with direct lifecycle meaning
- session supersede signals
- delivery or runtime failure conditions that require guard behavior
- atomic sections that temporarily prohibit interruption

This stage exists to preserve runtime correctness and avoid spending model
judgment on events that already have a clear deterministic meaning.

### Stage 2: Task-state-aware pre-filtering

This stage decides whether an event should enter relation classification at all.

Questions:

- Is there an active foreground task?
- Is the current phase atomic?
- Is this event obviously a background signal?
- Is the event obviously unrelated and non-actionable?

Possible outcomes:

- handle now without relation classification
- delay until the current atomic section finishes
- route into relation classification

### Stage 3: Relation classification

This stage assigns the event to one of the relation labels described above.

This is the main model-friendly semantic layer. It is the right place for:

- heuristics
- retrieval-augmented context
- a low-latency classifier model

### Stage 4: Action selection

Once relation is known, the supervisor combines:

- relation label
- current phase
- interrupt preference
- event urgency

to select a supervisor action.

### Stage 5: Runtime translation

The chosen supervisor action is translated into the existing execution substrate:

- active-run abort
- queue append
- steering injection
- followup enqueue
- session generation update
- future deferred-task storage

## What should be pre-routed before the model

Not every event belongs in the relation classifier.

### Definitely pre-route

- explicit hard-stop commands
- explicit cancel commands
- explicit approvals or rejections when they target a known pending action
- session supersede events
- stale-output guard transitions
- atomic runtime boundaries
- low-level delivery failures

### Usually pre-route

- timer events that are clearly reminder-like
- system health and channel connectivity events
- task completion and task failure notifications

### Usually send into relation classification

- user messages that may supplement, correct, replace, or branch the current
  task
- ambiguous side questions
- contextual insertions that may be foreground-worthy or deferrable

## Why relation classification is still a model problem

The relation layer is intentionally semi-structured.

That is a feature, not a bug. The purpose of the relation taxonomy is not to
eliminate model judgment. Its purpose is to constrain model judgment to a small,
reviewable label space.

This allows OpenClaw to:

- keep runtime behavior understandable
- make retrieval and few-shot prompting more targeted
- build evaluation sets with stable labels
- later train a compact policy model on relation labels instead of free-form
  reasoning alone

## Supervisor Action Mapping

The first-pass default mapping should look like this:

| Relation               | Default action            |
| ---------------------- | ------------------------- |
| `same_task_supplement` | `append`                  |
| `same_task_correction` | `steer`                   |
| `same_task_control`    | depends on control intent |
| `new_task_replace`     | `abort_and_replace`       |
| `new_task_parallel`    | `pause_and_fork`          |
| `background_relevant`  | `defer`                   |
| `unrelated`            | `continue`                |

This table is intentionally incomplete in one place:

- `same_task_control`

That relation should be expanded by deterministic control semantics:

- stop -> `abort_and_replace` or `continue` with stop-state depending on target
- continue -> `continue`
- approve -> `continue` or task-state advancement
- reject -> `defer`, `abort_and_replace`, or failure transition depending on
  pending action

## Runtime Integration Direction

The first implementation should not replace the current queue runtime.

Instead, it should layer on top of it:

- preserve current queue and session-generation mechanics
- introduce event normalization and task-state tracking
- insert supervisor decisions before existing queue/arbitration execution
- translate new supervisor actions into current queue/runtime operations

This keeps the migration incremental and reduces the risk of destabilizing the
agent loop.

## Initial Engineering Skeleton

The first implementation should prioritize insertion points and data capture
over ambitious task orchestration. The main objective is to create a stable
runtime seam where a lightweight classifier can operate and where decision
records can be captured for later improvement.

### 1. Supervisor seam placement

The first supervisor seam should be inserted before current queue arbitration is
translated into runtime behavior.

#### Recommended insertion point

Primary seam:

- `src/auto-reply/reply/get-reply-run.ts`

Reason:

- this is where the runtime already knows:
  - whether there is an active embedded run
  - whether that run is streaming
  - queue state
  - explicit queue directives
  - current arbitration inputs

At this point, the system can evaluate:

- current run state
- current task state snapshot
- normalized inbound event
- optional retrieved context

before choosing a supervisor action.

#### Near-term translation strategy

The first supervisor layer should not replace the current queue path.
Instead, it should emit supervisor actions that are translated into the current
execution substrate:

- `append` -> current followup/collect-style enqueue path
- `steer` -> current steer injection path
- `abort_and_replace` -> current abort + clear + restart path
- `continue` -> no-op for current task state
- `defer` -> store for later, without disturbing the active run
- `pause_and_fork` -> initially degrade to defer or controlled followup until
  full parallel task support exists

This keeps the seam useful even before full task-runtime support exists.

### 2. Task state provider

The supervisor seam needs a compact task-state snapshot.

The first version should not attempt a full persistent task graph. It should
derive a minimal foreground-task snapshot from current session/run state.

Initial snapshot fields:

- `sessionKey`
- `activeRun`
- `streaming`
- `phase`
- `interruptPreference`
- `atomic`
- `currentGoalSummary`
- `currentStepSummary`
- `queueDepth`
- `deferredItemCount`

Some of these will initially be heuristically derived rather than deeply
modeled. That is acceptable in the first phase.

### 3. Supervisor classifier interface

The first classifier should operate over a typed, narrow interface.

Proposed shape:

```ts
type SupervisorDecisionInput = {
  taxonomyVersion: string;
  event: SupervisorEvent;
  taskState: SupervisorTaskState;
  recentContextSummary?: string;
  retrievedExamples?: SupervisorRetrievedExample[];
};

type SupervisorDecisionOutput = {
  relation: string;
  action: string;
  confidence?: number;
  rationale?: string;
  model?: {
    provider?: string;
    model?: string;
  };
};
```

The runtime should treat `relation` and `action` as ids constrained by the
loaded taxonomy version.

### 4. Decision record pipeline

Every supervisor decision should produce a structured record, regardless of
whether the decision came from:

- deterministic pre-routing
- heuristic classification
- retrieval-augmented model classification

This record is the base unit of the future data flywheel.

## Decision Record Design

### Why a decision record exists

The system will not improve reliably unless each arbitration/supervisor decision
can later be:

- replayed
- inspected
- weakly labeled by outcome
- promoted into a curated training or evaluation example

### Minimum record shape

Proposed first-pass shape:

```ts
type SupervisorDecisionRecord = {
  id: string;
  timestamp: number;
  taxonomyVersion: string;
  sessionKey?: string;
  taskId?: string;
  event: SupervisorEvent;
  taskStateSnapshot: {
    phase: string;
    interruptPreference: string;
    atomic: boolean;
    activeRun: boolean;
    streaming: boolean;
    queueDepth?: number;
  };
  relation: {
    id: string;
    source: "deterministic" | "heuristic" | "model";
    confidence?: number;
  };
  action: {
    id: string;
    source: "deterministic" | "heuristic" | "model";
  };
  classifier?: {
    provider?: string;
    model?: string;
    latencyMs?: number;
    promptHash?: string;
  };
  retrieval?: {
    exampleIds?: string[];
    memoryIds?: string[];
  };
  rationale?: string;
};
```

### Where the first records should live

The first version should prefer append-only JSONL records per agent/session
scope, similar to current session/transcript patterns.

Suggested first destination:

- under the agent runtime area near existing session artifacts

Exact storage path can be finalized during implementation, but it should follow
three rules:

- append-only
- easy to inspect locally
- cheap to transform into datasets later

### Why JSONL first

JSONL is enough for the first phase because it is:

- easy to inspect
- easy to diff
- easy to reprocess into curated datasets
- aligned with current OpenClaw runtime logging patterns

If volume grows later, these records can be indexed or compacted without
changing the initial capture contract.

## Data Flywheel Design

### Goal

The first data flywheel should not aim for perfect labels. It should aim to
capture enough structured behavior to support:

- online debugging
- weak supervision
- manual curation
- future small-model fine-tuning or evaluation

### Three layers of data

#### 1. Raw decision records

One record per supervisor decision.

Purpose:

- runtime observability
- direct inspection
- later aggregation

#### 2. Outcome correlation records

The system should attach later evidence to the earlier decision whenever
possible.

Examples of useful signals:

- user immediately corrected the assistant
- a supposedly deferred request came back quickly as urgent
- a forked task was never resumed
- an append decision was followed by a correction
- a replace decision was followed by "no, I meant continue the previous task"

These later signals are the first weak labels of decision quality.

#### 3. Curated examples

From raw records plus outcomes, we should later derive:

- gold evaluation samples
- classifier prompt exemplars
- training examples for a compact policy model

This final layer should be much smaller and higher quality than the raw logs.

### First weak-supervision signals

The first useful signals do not require manual labeling infrastructure.
They can be inferred from downstream behavior.

Examples:

- correction within the next few turns
- explicit cancel or replace soon after a previous decision
- repeated user restatement of the same intention
- stale-output suppression after an earlier foreground decision
- defer items that are never resumed

These are imperfect signals, but they are strong enough to start a flywheel.

### Promotion path from log to dataset

The intended path should be:

1. capture runtime decision record
2. attach later outcome metadata
3. bucket records by relation/action/confusion type
4. sample high-value cases for human review
5. promote reviewed cases into:
   - eval fixtures
   - model prompt exemplars
   - training exports

This process avoids blocking the runtime on a perfect labeling system.

## First Runtime Milestones

The first implementation should land in narrow increments.

### Milestone 1

- add taxonomy runtime payload loader
- add supervisor seam in `get-reply-run.ts`
- add deterministic pre-routing shell
- add decision record emission

### Milestone 2

- integrate a small local classifier model through the supervisor seam
- constrain classifier outputs to taxonomy version `1`
- store classifier metadata in decision records

### Milestone 3

- add outcome-correlation pass
- derive first weakly labeled buckets
- create first curated evaluation set from real decisions

### Milestone 4

- revisit true `pause_and_fork` task support
- decide whether to keep hybrid heuristics or move more logic into a compact
  policy model

## First Runtime Layout

The first implementation should introduce a dedicated supervisor directory
instead of scattering new concepts across existing queue files.

### Proposed directory

- `src/auto-reply/reply/supervisor/`

This keeps the new layer separate from:

- existing queue logic in `src/auto-reply/reply/queue/`
- dispatch logic in `src/auto-reply/reply/dispatch-from-config.ts`
- low-level reply typing/dispatch infrastructure

### Proposed first file set

#### `src/auto-reply/reply/supervisor/types.ts`

Owns:

- `SupervisorEvent`
- `SupervisorTaskState`
- `SupervisorDecisionInput`
- `SupervisorDecisionOutput`
- `SupervisorDecisionRecord`

Purpose:

- create a typed boundary for the new subsystem
- avoid leaking ad hoc object shapes through `get-reply-run.ts`

#### `src/auto-reply/reply/supervisor/taxonomy.v1.json`

Owns:

- canonical runtime taxonomy payload

Purpose:

- single machine-readable semantic source for runtime, tests, and evaluation

#### `src/auto-reply/reply/supervisor/taxonomy.ts`

Owns:

- loading and typing of `taxonomy.v1.json`
- runtime accessor helpers
- validation hook integration for tests/build-time checks

Purpose:

- prevent taxonomy ids from being duplicated as free-form constants elsewhere

#### `src/auto-reply/reply/supervisor/event-normalization.ts`

Owns:

- conversion from current runtime inputs into `SupervisorEvent`

Purpose:

- make the seam explicit
- isolate event-shape logic from decision logic

#### `src/auto-reply/reply/supervisor/task-state.ts`

Owns:

- derivation of the first `SupervisorTaskState` snapshot from current run/session
  state

Purpose:

- centralize the initial heuristic task-state provider
- make later persistent-task upgrades easier

#### `src/auto-reply/reply/supervisor/pre-route.ts`

Owns:

- deterministic pre-routing
- atomicity checks
- direct control handling

Purpose:

- keep hard guard logic separate from model-facing classification

#### `src/auto-reply/reply/supervisor/classify.ts`

Owns:

- relation classification interface
- heuristic and model-backed relation selection

Purpose:

- narrow one entry point for semantic relation judgment

#### `src/auto-reply/reply/supervisor/action-selection.ts`

Owns:

- relation -> action mapping with phase and interrupt-preference adjustment

Purpose:

- keep action policy readable and testable

#### `src/auto-reply/reply/supervisor/translate.ts`

Owns:

- translation from supervisor action to current queue/runtime behavior

Purpose:

- let the new supervisor layer sit on top of the old execution substrate

#### `src/auto-reply/reply/supervisor/decision-record.ts`

Owns:

- creation and persistence of `SupervisorDecisionRecord`

Purpose:

- keep observability and flywheel capture independent of action execution

#### `src/auto-reply/reply/supervisor/index.ts`

Owns:

- top-level orchestration entry point for the supervisor seam

Suggested public function:

```ts
evaluateSupervisorDecision(...)
```

### Why not put everything in `queue/`

The supervisor is a broader task-control layer, not merely a new queue mode.
Placing it under `queue/` would make the design smaller in the code tree than
it really is, and would encourage leaking task semantics into queue-specific
helpers.

## Initial Seam Wiring

### First call path

Recommended first call path:

1. `getReplyFromConfig(...)`
2. `runPreparedReply(...)`
3. `evaluateSupervisorDecision(...)`
4. translate supervisor result into current runtime behavior
5. continue into `runReplyAgent(...)` or an early return path

This keeps the new seam at the point where the system already has:

- session context
- queue settings
- active-run visibility
- model arbitration availability

### First implementation strategy

The first seam does not need to replace existing code all at once.
It can begin as a wrapper around the current arbitration path:

- normalize current inbound message into a `user_message` event
- derive minimal task state
- pre-route obvious hard cases
- classify relation for ambiguous cases
- select supervisor action
- translate that action back into:
  - current queue mode decisions
  - abort behavior
  - steer behavior
  - followup/defer behavior

This lets the seam land without destabilizing the rest of the pipeline.

## Decision Record Storage

The first data-capture pipeline should be cheap and local-first.

### Proposed storage form

- append-only JSONL

### Proposed path family

Under the same agent/session storage area already used by the runtime, with a
parallel structure for supervisor decisions.

The exact final pathname can be chosen during implementation, but it should be
consistent with existing agent-owned state under `~/.openclaw/agents/<agentId>/`.

Suggested shape:

- `~/.openclaw/agents/<agentId>/supervisor-decisions/<SessionId>.jsonl`

This aligns with current runtime ergonomics:

- easy local inspection
- agent-scoped ownership
- no dependency on a database for first capture

### Why not store inside session transcript JSONL immediately

The decision record has a different purpose than the user/assistant transcript:

- transcript records conversation/runtime events
- decision record captures supervisor judgment and later outcome metadata

Keeping them separate makes it easier to:

- replay supervisor choices
- derive datasets
- redact or compact independently later

## Evaluation Dataset Placement

The first curated examples should live with reply test fixtures, not inside
docs.

### Proposed path

- `src/auto-reply/reply/test-fixtures/supervisor/`

### Expected file kinds

- `taxonomy-version.json`
- `relation-cases.jsonl`
- `action-cases.jsonl`
- `confusion-cases.jsonl`

These should all reference taxonomy ids from the runtime payload, not redefine
meanings inline.

## Build and Validation Hooks

The first implementation should add a lightweight validation path.

### Minimum validation plan

- schema validates `taxonomy.v1.json`
- tests verify all fixture relation/action ids exist in the runtime taxonomy
- tests verify the runtime taxonomy version is recorded on each decision record

This is enough to prevent silent semantic drift before classifier quality
testing even begins.

## Machine-Consumable Taxonomy Format

The relation and action definitions should not live only in prose. They should
also exist as a structured taxonomy artifact that can be consumed by:

- runtime code
- prompt builders
- retrieval pipelines
- evaluation tooling
- future training data generators

### Why keep a structured taxonomy file

The design doc is the human-readable contract. The taxonomy file is the
machine-readable mirror of that contract.

This separation keeps the system clean:

- prose explains intent and review rationale
- structured data powers implementation and testing

### Proposed artifact

Initial artifact:

- `docs/design/agent-supervisor-taxonomy.schema.json`

Later runtime-facing data files may live under `src/auto-reply/reply/supervisor/`
or a similar implementation directory, but the first step should define the
format independent of runtime code.

### Top-level shape

The taxonomy should contain:

- metadata
- event types
- execution phases
- interrupt preferences
- relation definitions
- action definitions

Minimal shape:

```json
{
  "version": "1",
  "events": [],
  "phases": [],
  "interruptPreferences": [],
  "relations": [],
  "actions": []
}
```

### Relation entry shape

Each relation should include the same semantic fields used in the design
discussion:

- `id`
- `summary`
- `meaning`
- `positiveSignals`
- `negativeSignals`
- `examples`
- `commonConfusions`
- `defaultActionCandidates`

This is the structured equivalent of:

- judgment signals
- typical examples
- confusing boundaries

### Action entry shape

Each action should include:

- `id`
- `summary`
- `description`
- `typicalTriggers`
- `runtimeEffects`

The goal is to document not only what an action means, but also how it is
expected to affect execution.

### Event entry shape

Each event should include:

- `id`
- `category`
- `description`
- `defaultUrgency`
- `defaultScope`
- `likelyRelations`

This creates a bridge from normalized events to relation classification.

### Design rules for the taxonomy artifact

- Keep it small and explicit.
- Prefer arrays of stable identifiers over free-form nested prose.
- Use short natural-language strings for signals and examples.
- Keep runtime-specific mechanics out of the taxonomy unless they are stable.
- Treat it as a semantic source of truth, not as a complete execution config.

### Initial use cases

This structured taxonomy should support three near-term uses:

1. Prompt specification

- inject relation/action definitions into a classifier prompt
- constrain the label space for semantic judgment

2. Evaluation set design

- define valid labels for annotators
- validate labeled examples against a known taxonomy version

3. Retrieval support

- align retrieved examples to relation and action labels
- let the system search for "similar task-insertion situations", not only
  similar raw text

### Future runtime use

Once the semantics stabilize, the same taxonomy can inform:

- deterministic pre-routing tables
- relation-classifier prompts
- test fixtures
- training-data export

That is why the file should be versioned from the start.

## Source of Truth and Synchronization Rules

The taxonomy system needs one semantic contract and one runtime copy. It should
not grow separate drifting copies for docs, runtime, and evaluation.

### Proposed layering

#### 1. Human-readable semantic contract

Primary review surface:

- `docs/design/agent-supervisor-task-control.md`

Purpose:

- explain concepts
- justify boundaries
- document rationale and tradeoffs

#### 2. Structured shape contract

Validation artifact:

- `docs/design/agent-supervisor-taxonomy.schema.json`

Purpose:

- define the legal machine-readable shape
- validate taxonomy payloads
- keep downstream tooling honest

#### 3. Runtime semantic payload

Planned canonical runtime copy:

- `src/auto-reply/reply/supervisor/taxonomy.v1.json`

Purpose:

- serve as the single machine-readable semantic source for runtime code
- be imported by tests and future evaluation tooling
- version semantic changes explicitly

#### 4. Evaluation datasets

Planned placement:

- `src/auto-reply/reply/test-fixtures/supervisor/`

Purpose:

- hold labeled examples
- reference taxonomy ids only
- avoid redefining semantic meanings inline

### Why runtime should have a single payload file

Once implementation begins, runtime logic should consume one versioned taxonomy
payload, not the docs example file and not hand-copied constants in multiple
TypeScript files.

That gives us:

- one semantic payload for runtime decisions
- one schema for validation
- one prose document for explanation

This is the narrowest structure that still scales cleanly.

### Role of the current example file

Current artifact:

- `docs/design/agent-supervisor-taxonomy.example.json`

This file is a design-stage seed, not the long-term runtime source.

Once the first runtime implementation begins, the expected migration is:

1. validate the example payload against the schema
2. copy or transform it into `src/auto-reply/reply/supervisor/taxonomy.v1.json`
3. treat the runtime payload as the canonical machine-readable source
4. keep the docs example only if it still adds explanatory value

### Synchronization rule

The synchronization rule should be simple:

- prose defines meaning
- schema defines shape
- runtime payload defines machine-consumed semantics
- eval data only references runtime payload ids

In practice:

- any semantic change starts in the design doc
- the schema is updated only if the data shape changes
- the runtime payload is updated whenever meanings, labels, or defaults change
- eval fixtures are updated only to reflect changed ids or changed expected
  mappings

### Drift policy

The following drift is not acceptable:

- runtime payload contains relations or actions missing from the design doc
- eval fixtures define labels not present in the runtime payload
- schema permits fields not described by the design

The following drift is acceptable temporarily during design:

- docs example file may lag behind the eventual runtime location
- prose may contain richer explanation than the runtime payload

### Versioning rule

The runtime taxonomy file should be versioned in the filename and inside the
payload:

- filename example: `taxonomy.v1.json`
- payload field: `"version": "1"`

This is important for:

- evaluation reproducibility
- classifier prompt stability
- future model training exports

### Runtime loading rule

When the runtime implementation begins, runtime code should:

- load exactly one taxonomy payload version
- validate it against the schema during tests or build-time checks
- expose the parsed taxonomy through a typed helper module

The runtime should not:

- manually duplicate taxonomy labels in code constants
- load different payloads for runtime and evaluation
- infer semantics from prose files

### Evaluation rule

Evaluation examples should store:

- taxonomy version
- event input
- task state snapshot
- expected relation id
- expected action id

They should not restate relation definitions or action meanings. Those belong to
the runtime taxonomy payload.

## Supervisor Inputs

The supervisor should make decisions from four buckets of input.

### 1. Runtime State

- active task existence
- execution phase
- atomic vs interruptible state
- tool/commit activity

### 2. Task Summary

- current goal
- latest completed step
- current intermediate artifact
- interrupt preference

### 3. New Event

- event type
- event payload
- event source
- event urgency
- relation candidate to current task

### 4. Retrieved Experience

- similar prior interruptions
- user-specific conversational style
- known misclassification patterns
- recent task-switch behavior

This structure supports both short-term heuristics and future retrieval-backed
or learned policies.

## Supervisor Actions

The supervisor should emit a stable action vocabulary that is more expressive
than the current queue-level one.

Minimal first version:

- `continue`
- `append`
- `steer`
- `pause_and_fork`
- `abort_and_replace`
- `defer`

Interpretation:

- `continue`: ignore the event for now, keep current execution path
- `append`: merge new information into the current task without changing course
- `steer`: redirect the current task while staying in the same foreground task
- `pause_and_fork`: keep current task resumable, but open a new foreground task
- `abort_and_replace`: terminate the current foreground task and replace it
- `defer`: acknowledge or store the event for later follow-up

These actions are a better semantic target than `interrupt / steer / collect`.

## Deterministic vs Model-Driven Boundaries

### Must remain deterministic

- physical atomic sections
- stale reply suppression
- generation changes
- queue clearing and active-run replacement
- begin/end consistency
- explicit hard-stop user commands

### May be model-driven

- event-to-task relation classification
- whether a new event deserves immediate foreground focus
- whether a side question should fork or defer
- whether a correction is local steering or a task replacement
- whether the current task should yield based on semantics and style

The guiding rule is:

- correctness is deterministic
- task strategy is model-assisted

## Role of Retrieval and Learned Policy

This design intentionally leaves room for two later layers:

### Retrieval-backed arbitration

Near-term, the supervisor can improve by retrieving:

- similar prior task interruptions
- same-user interaction patterns
- recent decisions with good or bad outcomes

This is likely the best first step because it improves semantic input quality
without introducing a training dependency.

### Lightweight policy model

Long-term, the decision boundary is narrow enough to fit a small specialized
model. A compact policy model could learn:

- task relation classification
- yield vs continue behavior
- side-task routing
- defer heuristics

That model should be trained on a well-defined supervisor action space, not on
raw ad hoc queue labels alone.

## Rollout Strategy

### Phase 1

- document the supervisor model
- preserve current queue arbitration as the execution substrate
- add explicit event and phase concepts without changing behavior broadly

### Phase 2

- route current queue arbitration through a supervisor decision layer
- keep `interrupt / steer / collect` as a compatibility output beneath the new
  action layer

### Phase 3

- add retrieval-backed event context
- start collecting structured examples of:
  - event
  - task state
  - supervisor action
  - observed outcome

### Phase 4

- evaluate whether a lightweight learned policy can replace or narrow the
  heuristic path

## Open Questions

- Should `pause_and_fork` create a new session immediately, or first create a
  task record within the same session?
- How should foreground and background tasks be surfaced to the user in
  messaging channels with limited UI?
- Should task preference be model-generated every turn, or declared once and
  updated only at phase boundaries?
- Which event types require explicit user-facing acknowledgment before being
  deferred?

## Summary

The supervisor should become the component that manages:

- active foreground work
- task phase
- interruptibility
- event-driven control

Current queue arbitration then becomes one part of a broader task control
system rather than the system's top-level policy engine.
