---
title: "Meta Skill Migration Design"
summary: "Design for migrating OpenSquilla-style meta skills into OpenClaw as a native TypeScript runtime."
---

# Meta Skill Migration Design

## Purpose

Migrate the OpenSquilla meta skill system into OpenClaw as a native TypeScript
runtime. The target is the full OpenSquilla-level capability: meta skill
frontmatter, composition DAG execution, soft activation through `meta_invoke`,
`user_input` pause and resume, creator proposal generation, runtime gates,
auto-propose, and a stable bundled meta skill catalog.

The migration should adapt the OpenSquilla design to OpenClaw boundaries rather
than wrap the Python implementation as a sidecar.

## Source Behavior

The design is based on a read-only inspection of the OpenSquilla `main` branch
meta skill surfaces:

- `src/opensquilla/skills/meta/types.py`
- `src/opensquilla/skills/meta/parser.py`
- `src/opensquilla/skills/meta/orchestrator.py`
- `src/opensquilla/skills/meta/scheduler.py`
- `src/opensquilla/skills/meta/executors/user_input.py`
- `src/opensquilla/engine/steps/meta_resolution.py`
- `src/opensquilla/skills/creator/proposer.py`
- `src/opensquilla/skills/creator/runtime_e2e.py`
- `src/opensquilla/skills/creator/auto_propose.py`
- `src/opensquilla/skills/bundled/meta-skill-creator/SKILL.md`

The OpenSquilla system has four core ideas:

- A `kind: meta` skill frontmatter contract with `triggers`, `composition`,
  risk metadata, and `final_text_mode`.
- A typed DAG runtime with step kinds such as `llm_chat`, `llm_classify`,
  `agent`, `tool_call`, `skill_exec`, and `user_input`.
- A pause and resume product flow for clarification, backed by awaiting run
  state rather than ordinary chat retries.
- A meta skill creator that generates skill proposals through gated internal
  tooling instead of directly hand-writing active skills.

## OpenClaw Fit

OpenClaw already has a governed skill generation surface: Skill Workshop.
Generated skills should continue to go through pending proposals, scanner
gates, hash binding, approval, and apply-only live writes. Meta skill creator
must use Skill Workshop as its output boundary.

OpenClaw's normal skill loading and prompt injection should remain lightweight.
The existing generic skill contracts should not become a broad structured
workflow runtime. Meta skill parsing should be an OpenClaw-specific projection
layer over loaded skill frontmatter.

Runtime state should use SQLite. The meta runtime must not add JSON, JSONL, TXT,
or sidecar files for run state, pause state, audit state, queues, or caches.
Skill Workshop proposal storage remains the existing exception because it is an
existing governed product artifact.

## Goals

- Support `kind: meta` skills with structured `composition` DAGs.
- Add a `meta_invoke` runtime path for deterministic and soft meta skill
  activation.
- Execute all OpenSquilla step families needed for complete behavior parity:
  `llm_chat`, `llm_classify`, `agent`, `tool_call`, `skill_exec`, and
  `user_input`.
- Preserve pause and resume semantics for clarification flows.
- Persist meta runs, step outputs, pause records, and evidence in SQLite.
- Integrate `meta-skill-creator` with Skill Workshop proposals.
- Support runtime E2E gates and auto-propose on top of the same runtime.
- Ship a stable bundled meta skill catalog only after the runtime and gates are
  proven.

## Non-Goals

- Do not run OpenSquilla Python as a sidecar.
- Do not bypass Skill Workshop for generated skills.
- Do not write active `SKILL.md` files directly from meta skill creator.
- Do not add runtime compatibility shims for old or malformed meta config.
- Do not make plugins own core meta workflow policy.
- Do not treat tests for removed fallback paths as contracts.

## Architecture

The recommended architecture is a native OpenClaw meta runtime with six bounded
components:

1. `meta-skill-loader`

   Scans loaded skill entries for `kind: meta`, parses the structured
   frontmatter fields, and exposes valid meta definitions to the agent runtime.
   Invalid definitions produce diagnostics and are excluded from meta
   invocation without affecting ordinary skill loading.

2. `meta-plan-parser`

   Converts frontmatter into a typed `MetaPlan`. It validates step ids,
   duplicate ids, dependency references, cycles, supported step kinds, route
   cases, `when` expressions, `on_failure`, `final_text_mode`, tool allowlists,
   skill references, and `user_input` schema fields.

3. `meta-runner`

   Owns DAG scheduling, context assembly, template rendering, parallel branch
   execution, final output selection, failure policy, recursion guards, and run
   lifecycle events.

4. `meta-step-executors`

   Implement step behavior through existing OpenClaw seams:
   - `llm_chat` and `llm_classify` call the agent model/runtime abstraction.
   - `agent` delegates to the existing agent execution surface.
   - `tool_call` invokes registered agent tools through the normal tool
     contract.
   - `skill_exec` runs ordinary skills through the existing skill execution
     path, not through direct filesystem reads.
   - `user_input` writes a paused run and returns a channel-safe request for
     missing fields.

5. `meta-run-store`

   Persists canonical meta runtime state in SQLite. Runtime reads and writes use
   OpenClaw's normal database helpers and typed row mappings.

6. `meta-skill-creator` integration

   Ports the OpenSquilla creator flow as a bundled meta skill backed by internal
   creator tools. The final write boundary is Skill Workshop proposal creation
   or update. Gate outputs and runtime E2E evidence attach to the proposal
   record or to meta evidence rows that reference the proposal id.

## Activation Flow

1. Load ordinary skills.
2. Project valid `kind: meta` definitions into a meta catalog.
3. On each user turn, inspect the request, active session state, and pending
   pause records.
4. If a paused run owns the session and can resume, route the message to resume
   that run.
5. Otherwise evaluate meta triggers:
   - Deterministic trigger match may force `meta_invoke`.
   - Ambiguous match adds a soft prompt hint and lets the model decide.
   - No match leaves the normal agent loop untouched.
6. `meta_invoke` creates a run and hands execution to `meta-runner`.
7. The runner emits final text according to `final_text_mode`.

This keeps meta skills as a routing and orchestration layer, not a replacement
for the ordinary agent loop.

## Run Data Flow

Each run starts with:

- Original user message.
- Agent id, session id, run id, channel target, and workspace context.
- Matched meta skill definition and trigger metadata.
- Template variables derived from user input and previous steps.

Each step receives:

- The rendered step input.
- Prior step outputs requested through dependencies.
- Runtime context that is intentionally narrow and serializable.

Each step returns:

- A typed output payload.
- Human-readable summary text when useful.
- Optional evidence or artifact references.
- Status and error metadata.

The runner writes step state before and after execution. On success, it advances
dependent steps. On failure, it applies the configured failure policy. On
`user_input`, it writes a pause record and returns a paused result instead of
marking the run failed.

## SQLite State Model

Use one SQLite owner for meta runtime state:

- `meta_skill_runs`
  - Run id, skill key, agent id, session id, agent run id, status, trigger
    metadata, original input summary, final mode, created time, updated time,
    completed time.
- `meta_skill_steps`
  - Run id, step id, kind, dependency state, status, rendered input JSON, output
    JSON, error JSON, started time, completed time.
- `meta_skill_pauses`
  - Run id, step id, schema JSON, prefill JSON, confirmed field JSON, channel
    binding, session binding, status, expiration time, resumed time.
- `meta_skill_evidence`
  - Run id, step id, proposal id, gate name, result, risk level, artifact refs,
    created time.

The runtime reads only these canonical tables. If a future release needs
migration from experimental state, that migration belongs in doctor or migration
code, not in steady-state runtime fallback readers.

## Creator Flow

The bundled `meta-skill-creator` should use the same meta DAG runtime as user
workflows. Its OpenClaw flow is:

1. Clarify creator intent.
2. Harvest relevant prior context when available.
3. Fill slots for name, trigger, audience, required tools, and risk profile.
4. Assemble a `SKILL.md` proposal body and optional support files.
5. Run lint and scanner checks.
6. Run collision checks against loaded skill names and reserved names.
7. Run runtime E2E gates for at least one representative invocation when the
   mode requires gated proof.
8. Call Skill Workshop to create or update a pending proposal.
9. Return the proposal id, gate summary, and next available actions.

The creator never applies a proposal automatically unless the existing Skill
Workshop policy and user/operator action allow it.

## Auto-Propose Flow

Auto-propose should be built after creator integration is stable. It consumes
durable signals such as recurring user workflows, repeated skill co-occurrence,
or maintainer-approved telemetry. It filters candidates by frequency, coverage,
risk, existing proposals, and trigger collisions.

Auto-propose creates pending Skill Workshop proposals only. It does not create
live skills, alter bundled skills, or silently enable new user-facing behavior.

## Error Handling

Definition errors:

- Parse failures, unknown step kinds, bad dependencies, cycles, invalid route
  cases, or invalid `final_text_mode` produce load diagnostics.
- The invalid meta skill is excluded from the meta catalog.
- Ordinary skills continue to load.

Runtime errors:

- Default behavior is fail closed.
- Supported failure policies include skip, substitute, and bounded failover
  where the DSL explicitly declares them.
- Step errors are persisted with enough structured detail for debugging.
- Final responses name the failed step and the blocked capability.

Resume errors:

- Expired pauses, session mismatches, terminated runs, and invalid resume input
  return a visible resume error.
- The runtime should not silently start a new meta run unless the user request
  independently matches a trigger.

Security and ownership errors:

- Tool and skill calls obey the same authorization, sandbox, and allowlist
  behavior as ordinary agent turns.
- Creator writes go through Skill Workshop only.
- Plugin-specific policy remains in plugin-owned seams; core meta runtime owns
  generic orchestration only.

## Testing Strategy

Parser tests:

- Valid and invalid `kind: meta` frontmatter.
- Supported step kinds.
- Duplicate ids, missing dependencies, cycles, and topology.
- `final_text_mode` variants.
- `user_input` schema validation.
- Unknown tools and skills.

Runner tests:

- Sequential and parallel DAG execution.
- Template rendering.
- Step output propagation.
- Failure policy behavior.
- Final output selection.
- Recursion protection.

Pause and resume tests:

- Pause record creation.
- Resume with same session.
- Reject resume from wrong session or expired pause.
- Confirmed field handling.
- Restart behavior after terminal run state.

Creator tests:

- Creator produces pending Skill Workshop proposals.
- Proposal evidence includes gate summaries.
- Creator does not apply proposals by default.
- Collision checks prevent duplicate active skill names.

Runtime E2E tests:

- One bundled meta skill through a full agent and tool path.
- One `user_input` clarification path across two turns.
- One creator path that returns a proposal id and gate result.

Diagnostics tests:

- Bad meta skill does not break ordinary skill loading.
- Load diagnostics are visible to operators.
- Proposal or gate failures are persisted and reported.

## Migration Phases

Although the target scope is complete, implementation should land in four
verified phases:

1. Parser and loader

   Add the meta definition projection, parser, diagnostics, and tests. No user
   activation yet.

2. Runner and invocation

   Add `meta_invoke`, DAG execution, core step executors, failure policies,
   recursion protection, and focused runtime tests.

3. Pause, resume, and audit

   Add SQLite run state, pause records, resume routing, evidence rows, and
   cross-turn tests.

4. Creator, gates, auto-propose, and catalog

   Port `meta-skill-creator`, wire Skill Workshop proposal output, add runtime
   E2E gates, add auto-propose, and ship the stable bundled catalog after proof.

Each phase should have a narrow proof target and should not depend on broad
release validation until the phase has focused local test coverage.

## Documentation Impact

The public docs should change only when the runtime becomes user-visible.
Likely pages:

- `docs/tools/skills.md` for the `kind: meta` skill format.
- `docs/tools/skill-workshop.md` for creator-generated proposal evidence.
- `docs/tools/creating-skills.md` for authoring guidance once supported.
- `docs/cli/skills.md` if new CLI inspection or diagnostics commands are added.

Internal implementation design should not be added to `docs/docs.json` unless
it becomes public user documentation.

## Open Questions For Implementation Planning

- Which existing OpenClaw model/runtime abstraction should back `llm_chat` and
  `llm_classify` without creating a second agent loop?
- Which existing tool invocation seam can enforce the same authorization and
  sandbox rules for `tool_call` steps?
- Should meta diagnostics surface through `openclaw skills check`, Gateway
  health, or both?
- What is the safest channel-neutral shape for `user_input` prompts and resume
  tokens?
- Which bundled meta catalog entries should ship first after creator proof?

These are implementation planning questions. They do not change the approved
architecture.

## Verification Before Implementation

Before implementation starts, the plan should identify the exact files and
commands for each phase. A completed implementation should include:

- Focused parser, runner, pause/resume, creator, and diagnostic tests.
- SQLite schema and migration proof.
- Skill Workshop integration proof that proposals remain pending until apply.
- Runtime E2E proof for at least one full meta skill and one clarification
  resume path.
- Documentation updates only when user-visible behavior exists.
