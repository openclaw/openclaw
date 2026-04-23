---
name: agent-audit
description: Audit an agent runtime with structured evidence, severity-ranked findings, and an ordered fix plan. Use when an agent wrapper, assistant, or orchestration stack behaves worse than the base model, skips tools, leaks stale memory, or mutates good answers during delivery.
metadata: { "openclaw": { "emoji": "🩺" } }
---

# Agent Audit

Use this skill to audit the **agent system itself**, not to complete the user's domain task.

Typical triggers:

- "Why is this wrapped agent worse than the base model?"
- "Why does it skip tools?"
- "Why does stale memory leak into new turns?"
- "Why does the final answer get mutated during retries or rendering?"
- "Audit this agent runtime end to end"

## Core rule

Work **evidence-first** and **JSON-first**.

Do not jump directly to prose conclusions.

Before writing the user-facing diagnosis, build these artifacts in order:

1. `agent_check_scope.json`
2. `evidence_pack.json`
3. `failure_map.json`
4. `agent_check_report.json`

## Audit target

Audit the full stack, not only the current prompt:

1. system prompt and role shaping
2. session history injection
3. long-term memory retrieval
4. summaries or distillation
5. active recall or recap layers
6. tool routing and selection
7. tool execution
8. tool-output interpretation
9. answer shaping
10. platform rendering or transport
11. fallback or repair loops
12. persistence and stale state

## Required working style

- Prefer direct evidence: code, config, logs, payloads, DB rows, screenshots, and tests.
- Treat a clean current state as insufficient if the failure was historical.
- Prefer code and configuration fixes over prompt-only fixes.
- Be explicit about confidence and contradictions.
- If the wrapper is the problem, say so directly.

## Artifact contracts

Read these references before or during the audit:

- `{baseDir}/references/report-schema.json`
- `{baseDir}/references/rubric.md`
- `{baseDir}/references/playbooks.md`
- `{baseDir}/references/advanced-playbooks.md`
- `{baseDir}/references/example-report.json`
- `{baseDir}/references/trigger-prompts.md`

### `agent_check_scope.json`

Define:

- target system
- entrypoints
- channels or surfaces
- model stack
- time window of interest
- symptoms
- layers to audit

### `evidence_pack.json`

Capture:

- exact files and code locations
- logs, payloads, DB rows, config files, and screenshots
- whether each item is current, historical, or mixed
- missing evidence that blocks confidence

### `failure_map.json`

For each failure mode include:

- severity
- symptom
- user impact
- source layer
- mechanism
- root cause
- evidence refs
- recommended fix

### `agent_check_report.json`

Render the final structured report with:

- executive verdict
- severity-ranked findings
- conflict map across layers
- contamination paths
- ordered fix plan

## Standard playbooks

Use the closest playbook from `{baseDir}/references/playbooks.md`:

- `wrapper-regression`
- `memory-contamination`
- `tool-discipline`
- `rendering-transport`
- `hidden-agent-layers`

If the runtime is more deeply compromised, use an advanced playbook from
`{baseDir}/references/advanced-playbooks.md`.

## Recommended workflow

1. Create the scope artifact.
2. Gather direct evidence.
3. Map the failure modes.
4. Build the final report from the structured artifacts.
5. Present:
   - severity-ranked findings first
   - architecture diagnosis second
   - ordered fix plan third

## Output rules

- Lead with findings, not compliments.
- Do not hide uncertainty.
- Do not blame the base model unless wrapper layers have been falsified.
- Do not improvise a new theory after producing the report. Render from the structured report.

## Example prompt

Use `agent-audit` to inspect this agent runtime for wrapper regression and tool-discipline failures. Focus on stale evidence reuse, hidden repair layers, and whether tool requirements are enforced in code or only described in prompts. Build the JSON artifacts first, then give me severity-ranked findings and a fix order.
