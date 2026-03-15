---
name: attractor
description: Build, extend, and debug Attractor implementations from the strongdm/attractor specs. Use when work involves DOT pipeline DSL parsing, graph execution traversal, node handlers, checkpoint/resume state, human-in-the-loop gates, condition expressions, model stylesheet rules, or integrating coding-agent-loop/unified-llm backends.
metadata: { "openclaw": { "emoji": "🧲", "homepage": "https://github.com/strongdm/attractor" } }
---

# Attractor

Implement Attractor as a spec-driven orchestration layer, not as ad-hoc glue code.

## Source of truth

Read these specs before changing architecture:

- `attractor-spec.md`
- `coding-agent-loop-spec.md`
- `unified-llm-spec.md`

If local files are unavailable, use:

- <https://github.com/strongdm/attractor/blob/main/attractor-spec.md>
- <https://github.com/strongdm/attractor/blob/main/coding-agent-loop-spec.md>
- <https://github.com/strongdm/attractor/blob/main/unified-llm-spec.md>

## Execution order

1. Confirm scope.
2. Map requested work to specific spec sections.
3. Implement minimal, testable slices in this order:
   - DOT parser + schema validation
   - Graph normalization + static validation
   - Execution engine (state, traversal, edge selection)
   - Node handler registry + built-in handlers
   - Checkpoint/resume persistence
   - Human-in-the-loop pause/resume flow
   - Model stylesheet and condition evaluator
4. Add focused tests for each implemented slice.
5. Verify behavior against acceptance criteria from the relevant section.

## Scope mapping checklist

Map each task to one or more of these components:

- **DOT DSL schema**: grammar subset, typed attributes, defaults, chained edges, subgraph scoping.
- **Execution engine**: session/run state, deterministic traversal, retries, timeouts, loop handling.
- **Node handlers**: `start`, `exit`, `codergen`, `wait.human`, `conditional`, `parallel`, `parallel.fan_in`, `tool`, `stack.manager_loop`.
- **State and context**: run context shape, per-node outputs, status normalization.
- **Human-in-the-loop**: blocking prompts, explicit response routing, resumable state.
- **Model stylesheet**: selector precedence, inheritance, node-level override merge.
- **Condition language**: parser/evaluator behavior, truthiness, error handling.
- **Transforms/extensibility**: pre/post transforms, plugin-like handler registration, event hooks.

## Guardrails

- Keep Attractor decoupled from the LLM backend. Use backend interfaces, not provider-specific calls in core traversal logic.
- Keep graph execution deterministic. If multiple edges are eligible, apply documented priority rules (condition, weight, label preferences) consistently.
- Reject invalid graph inputs early with clear errors (do not silently coerce malformed data).
- Keep checkpoint payloads stable and serializable to support crash-safe resume.
- Preserve separation between:
  - orchestration (Attractor),
  - coding agent loop,
  - unified LLM client.
- Do not invent undocumented node types, attributes, or condition operators unless explicitly requested.

## Testing requirements

Always add or update tests for changed behavior:

- Parser acceptance tests for valid DOT samples.
- Parser rejection tests for unsupported syntax and bad attributes.
- Execution tests for linear, conditional, retry, and parallel paths.
- Checkpoint/resume tests that simulate interruption and restart.
- Human-gate tests that pause, accept input, and continue correctly.
- Condition evaluation tests for happy path and invalid expressions.

## Implementation strategy for large requests

For multi-feature asks, split work into PR-sized increments:

1. Parser + validator foundation.
2. Core traversal + deterministic routing.
3. Handler implementations and HITL integration.
4. Stylesheet/condition language refinements.

Each increment should keep the engine runnable and test-backed.

## Delivery checklist

Before finishing:

- Confirm implementation matches cited spec sections.
- Confirm tests cover both success and failure paths.
- Confirm any new config/attributes are documented where users read them.
- Confirm no coupling leaks between orchestration and provider-specific adapters.
