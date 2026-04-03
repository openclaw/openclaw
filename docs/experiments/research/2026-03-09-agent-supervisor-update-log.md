# 2026-03-09 Agent Supervisor Update Log

## Scope

- Shifted design focus from message-only queue arbitration to task-aware agent
  supervision.
- Treated Feishu UI work as sufficiently staged for now and moved architecture
  discussion back to dialogue/task control.

## Key Decisions

- The current problem is not only "make the arbitrator smarter".
- OpenClaw needs a supervisor layer above queue arbitration.
- The supervisor should process normalized events, not only inbound messages.
- Runtime-level physical atomicity should stay deterministic.
- Semantic task-yield decisions should remain model-friendly.
- Task interrupt preference should default to `avoid`, not `free` or
  `critical`.
- Relation classification should sit between raw events and final supervisor
  actions.
- The system should use deterministic pre-routing before relation
  classification, rather than sending every event to a model.
- The first canonical runtime taxonomy copy should live as a single versioned
  payload, not as duplicated TypeScript constants.
- The first implementation should prioritize a supervisor seam and decision
  record pipeline before richer task orchestration.
- The new supervisor runtime should live in its own directory rather than being
  hidden inside `queue/`.
- Fast acknowledgement and accurate arbitration should be treated as separate
  concerns.
- Consumer-facing feedback should be layered:
  - received
  - working
  - staged progress
  - final outcome
- The second core consumer-facing track is now explicitly named the
  `conversation presentation layer`.
- Consumer experience should be treated as two cooperating problems:
  - how user input changes agent behavior
  - how agent internal process is translated into a comfortable dialogue
- Presentation policy should be channel-agnostic by default and driven more by
  supervisor action than by message length.
- A first presentation vocabulary should be:
  - `ack`
  - `status`
  - `milestone`
  - `final`
- Intermediate user-visible expression should stay light:
  keep internal state concrete, but let the model shape milestone wording.
- Fast reaction and rich expression may use different latency/model paths.
- Core presentation modules should declare explicit latency budgets up front.
- `ack/status/milestone` should target much tighter budgets than the main agent
  path.
- The runtime should maintain an `adaptive runtime profile`.
- The first runtime profile set should be:
  - `aggressive`
  - `balanced`
  - `conservative`
- Heartbeat should evolve from pure liveness checking into a lightweight
  observer for:
  - latency
  - timeout rate
  - fallback rate
  - pre-defined performance-based adaptation
- Profile adjustment should be asymmetric:
  downgrade quickly, upgrade slowly.
- Current design work should clearly separate:
  - runtime invariants
  - temporary model guardrails
  - model-owned policy

## Agreed Concepts

- Execution phase:
  - `idle`
  - `planning`
  - `acting`
  - `committing`
  - `waiting`
- Task interrupt preference:
  - `free`
  - `avoid`
  - `critical`
- Event taxonomy should include:
  - user events
  - task events
  - tool events
  - timer/schedule events
  - system/channel events
- Relation taxonomy should include:
  - `same_task_supplement`
  - `same_task_correction`
  - `same_task_control`
  - `new_task_replace`
  - `new_task_parallel`
  - `background_relevant`
  - `unrelated`
- Supervisor actions should be:
  - `continue`
  - `append`
  - `steer`
  - `pause_and_fork`
  - `abort_and_replace`
  - `defer`

## Current Runtime Observations

- `src/auto-reply/reply/get-reply-run.ts` already has active-run, streaming,
  queue, and arbitration state.
- `src/auto-reply/reply/agent-runner.ts` already contains implicit execution
  phases that can later be made explicit.
- `src/auto-reply/reply/abort.ts` already owns deterministic abort paths.
- `src/auto-reply/reply/dispatch-from-config.ts` already provides stale reply
  suppression via session generation.

## Design Direction

- Keep runtime correctness deterministic.
- Move semantic task control into a supervisor layer.
- Use retrieval/context engineering before attempting a specialized learned
  policy.
- Leave room for a future lightweight policy model once action labels and
  event/task schemas stabilize.
- Treat relation taxonomy as the semantic middle layer:
  - raw event -> pre-routing -> relation -> action
- Keep hard control and atomicity decisions outside model judgment.
- Treat "fast feedback" as a presentation/system-design concern rather than a
  full arbitration concern.
- Treat intermediate visible messages as planned presentation outputs rather
  than direct copies of internal runtime events.
- Avoid turning temporary classifier workarounds into permanent architecture.
- Use a four-layer asset model:
  - design doc
  - schema
  - runtime taxonomy payload
  - eval fixtures
- Use a three-layer data flywheel:
  - raw decision records
  - outcome correlation
  - curated examples
- First implementation path should be:
  - seam in `get-reply-run.ts`
  - runtime taxonomy payload
  - append-only JSONL decision records
  - eval fixtures under reply test fixtures

## Deliverables Added

- Formal design doc:
  - `docs/design/agent-supervisor-task-control.md`
- Machine-consumable taxonomy schema:
  - `docs/design/agent-supervisor-taxonomy.schema.json`
- Example taxonomy payload:
  - `docs/design/agent-supervisor-taxonomy.example.json`
- This technical update log:
  - `docs/experiments/research/2026-03-09-agent-supervisor-update-log.md`

## Next Step

- Start implementation from the new supervisor runtime directory and land the
  taxonomy loader plus seam before relation-classifier behavior expands.

## Runtime Skeleton Landed

- Added `src/auto-reply/reply/supervisor/` as the first runtime home for the
  supervisor layer.
- Added versioned runtime taxonomy payload:
  `src/auto-reply/reply/supervisor/taxonomy.v1.json`
- Added typed taxonomy loader in
  `src/auto-reply/reply/supervisor/taxonomy.ts`
- Added first event normalization, task-state inference, pre-routing, and
  legacy queue translation helpers.
- Added `SupervisorDecisionRecord` builder plus append-only JSONL writer.
- Added `SupervisorDecisionOutcomeRecord` builder plus append-only JSONL writer.
- Added the first `SupervisorRelationClassifier` interface and a legacy queue
  backed classifier implementation.
- Extended the classifier boundary so it can bootstrap from the existing local
  `messages.queue.arbitrator` provider.
  - The local model now classifies `relation` only.
  - Runtime queue behavior still follows the legacy arbitration result.
  - If the local classifier fails, decision recording falls back to legacy
    translation so the seam stays safe.
- Inserted a minimal seam in `src/auto-reply/reply/get-reply-run.ts`.
  - No behavior override yet.
  - Current role is to normalize the inbound user event, infer task state, map
    the existing queue decision into supervisor relation/action space, emit a
    decision record, and emit the first `runtime_applied` outcome record.
  - When the next turn is clearly a correction or replacement, the previous
    decision now also receives a weak-supervision `user_corrected` outcome.

## Verification

- Supervisor unit tests passed.
- Existing queue arbitration integration test passed.
- `pnpm tsgo` passed.
- `pnpm build` passed.
- `pnpm openclaw --help` passed.

## Result

The project now has a real runtime seam for the future supervisor layer:

- the taxonomy is machine-loadable
- the first decision record pipeline exists
- the first outcome correlation pipeline exists
- the first weak-supervision outcome signal (`user_corrected`) is now wired
- a relation-classifier boundary exists without requiring model integration yet
- `get-reply-run.ts` already has a place where supervisor logic can grow
- the current queue arbitrator can now be treated as a legacy translation input
  rather than the final task-control architecture
