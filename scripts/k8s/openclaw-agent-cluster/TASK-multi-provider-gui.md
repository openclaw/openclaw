# Task: GUI-First Multi-Provider Model Selection for k3s Agent Cluster

## Problem

The local k3s deployment currently starts with a single model choice at deployment time.
That makes provider switching feel "locked in" even though the Control UI can edit models.

## Goal

Enable a GUI-first workflow where operators can switch default model/provider after deployment
without re-running cluster bootstrap scripts.

## Scope

1. Bootstrap defaults and allowlist

- Keep `--model` as initial default.
- Seed `agents.defaults.models` with supported provider/model options.
- Prefer inherited defaults for cluster agents (avoid hardcoding per-agent model unless explicitly needed).

2. Runtime provider readiness in UI

- In Control UI, show model options with provider status (ready/missing credentials).
- Disable or warn on selection when required provider credentials are missing.

3. Cluster update flow

- Add a script helper to patch model settings only (no image rebuild/import required).
- Include restart strategy guidance (`rollout restart` only when needed).

4. Validation and smoke tests

- Verify switching default model in UI changes effective model for orchestrator and sub-agents.
- Verify websocket auth/pairing still works after model switch.
- Verify missing-key provider selection fails with actionable error text.

## Deliverables

- Script support for non-destructive model profile patching in-cluster.
- UI provider-readiness indicators in model selectors.
- End-to-end test coverage for model switching and missing credential behavior.
- README update with exact operator flow.

## Acceptance Criteria

- Operator can switch from `openai/gpt-5.2` to `anthropic/claude-opus-4-6` via UI in under 60 seconds.
- No full rebuild/reimport needed for model switch.
- Sub-agent runs inherit the updated effective default unless explicitly overridden.
- Failure path for missing credentials is obvious and points to the exact secret/env key.
