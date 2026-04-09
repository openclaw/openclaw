# Sense Runtime Tool

Formal runtime-plane entrypoints for the T550 control plane live in:

- `scripts/runtime/sense_runtime_bridge.py`
- `scripts/runtime/sense-runtime.sh`
- `scripts/runtime/sense-runtime-tool.sh`
- `scripts/runtime/sense-runtime-intent.sh`
- `scripts/runtime/sense_runtime_subprocess_tool.py`
- `scripts/runtime/sense-runtime-subprocess-tool.sh`
- `scripts/runtime/sense_runtime_manager_tool.py`
- `scripts/runtime/sense-runtime-manager-tool.sh`
- `scripts/runtime/sense_runtime_dispatcher.py`
- `scripts/runtime/sense-runtime-dispatcher.sh`
- `scripts/runtime/sense_runtime_decision.py`
- `scripts/runtime/sense-runtime-decision.sh`
- `scripts/runtime/sense_runtime_remediation.py`
- `scripts/runtime/sense-runtime-remediation.sh`

Minimal remediation mapping:

- `check_runtime_provider`
  - call `sense runtime start`
  - then re-run readiness decision
- `check_gpu_runtime`
  - re-read structured sandbox status
  - return GPU/NIM/policy capability fields
- `wait_for_runtime_ready`
  - retry decision check with backoff `2s, 4s, 8s`
- `review_runtime_capabilities`
  - summarize runtime capability fields from structured sandbox status

Remediation output shape:

```json
{
  "readiness": "degraded",
  "recommended_action": "check_runtime_provider",
  "remediation_action": "check_runtime_provider",
  "remediation_result": "triggered sense runtime start",
  "followup_status": {...},
  "next_step": "sense_runtime_start"
}
```

Decision + remediation sequence:

- `sense-runtime-decision.sh`
  - readiness decision only
- `sense-runtime-remediation.sh`
  - decision + minimal remediation
  - if `--recommended-action` is omitted, it uses the current decision result

Examples:

```bash
scripts/runtime/sense-runtime-remediation.sh \
  --token "$SENSE_WORKER_TOKEN" \
  --sandbox-name sense-wsl-agent

scripts/runtime/sense-runtime-remediation.sh \
  --token "$SENSE_WORKER_TOKEN" \
  --sandbox-name sense-wsl-agent \
  --recommended-action review_runtime_capabilities
```

Notes:

- remediation is intentionally minimal and reuses the existing runtime tool chain
- `401 unauthorized` still propagates as a hard failure
- `provider` and `model` may remain `unknown`; remediation does not branch on them yet
- the next natural step is to bind `recommended_action` values to richer automatic provider/GPU remediation workflows

# Sense Runtime Tool

Routing loop:

- `sense-runtime-routing-loop.sh`
- `sense_runtime_routing_loop.py`

Flow:

- decision
- remediation
- next_step evaluation
- runtime task execution

Loop behavior:

- max attempts is capped (`--max-attempts`, default `3`)
- repeated identical decision signatures stop the loop
- unmapped next steps stop safely

Handled next steps:

- `sense_runtime_start`
- `sense_runtime_status`
- `inspect_gpu_runtime`
- `run_runtime_task`

Manager-facing output:

```json
{
  "final_state": "stopped_repeated_decision",
  "executed_steps": [...],
  "last_decision": {...},
  "last_remediation": {...},
  "next_step": "sense_runtime_start"
}
```

Example:

```bash
scripts/runtime/sense-runtime-routing-loop.sh \
  --token "$SENSE_WORKER_TOKEN" \
  --sandbox-name sense-wsl-agent
```

# Sense Runtime Tool

Provider remediation notes:

- `check_runtime_provider` no longer means only `sense runtime start`
- it now collects provider-related signals from:
  - structured sandbox status
  - start result summary/key_points
  - follow-up readiness decision
- it returns `provider_status` with:
  - `provider`
  - `model`
  - `nim_status`
  - `gpu_enabled`
  - `provider_ready`
  - `missing_requirements[]`

Possible `missing_requirements` values include:

- `provider configuration missing`
- `model configuration missing`
- `nim is not running`
- `gpu runtime not enabled`
- `API key may be required`

Routing loop behavior change:

- if remediation returns `provider_status.provider_ready == false`
- the loop stops with:
  - `final_state = provider_not_ready`
  - `next_step = configure_provider`
- this avoids repeatedly calling `sense_runtime_start` without new signals

This is still a minimal remediation layer.
Provider and model may remain `unknown`, and the current logic uses them only to build `missing_requirements`, not to guess a concrete provider configuration automatically.

GPU remediation notes:

- `check_gpu_runtime` no longer only echoes current status
- it now returns `gpu_status` with:
  - `sandbox_name`
  - `phase`
  - `gpu_enabled`
  - `nim_status`
  - `runtime_name`
  - `openshell_status`
  - `policy_names`
  - `provider`
  - `model`
  - `nvidia_policy_present`
  - `gpu_required_policy_present`
  - `gpu_ready`
  - `missing_requirements[]`

Current `gpu_ready` rule is intentionally simple and based on existing structured sandbox signals:

- `phase == Ready`
- `gpu_enabled == true`
- `nim_status == running`
- `policy_names` contains `nvidia`
- `openshell_status == connected`

Possible GPU `missing_requirements` values include:

- `sandbox not ready`
- `gpu runtime not enabled`
- `nvidia policy missing`
- `nim is not running`
- `runtime not connected`

Routing loop behavior change:

- if remediation returns `gpu_status.gpu_ready == false`
- the loop stops with:
  - `final_state = gpu_not_ready`
  - `next_step = configure_gpu_runtime`

This is still a minimal remediation layer. It uses current structured sandbox fields and does not yet call a separate GPU probe or host-side scheduler inspection.

`configure_gpu_runtime` now performs a minimal real remediation attempt instead of only returning a next step:

- re-check current structured sandbox GPU signals
- trigger `sense runtime start`
- re-check runtime status
- re-check structured sandbox status
- rebuild `gpu_status` from the follow-up sandbox signals

Current behavior after remediation:

- if `gpu_status.gpu_ready == true`
  - `next_step = run_runtime_task`
- if `gpu_status.gpu_ready == false`
  - `next_step = configure_gpu_runtime`
  - routing loop stops with `final_state = gpu_not_ready`

This is intentionally conservative. It can improve readiness when runtime start fixes a transient issue, but if GPU runtime prerequisites are still missing, the loop stops with a structured explanation instead of retrying indefinitely.

Missing-requirements routing priority:

- `API key missing: ...` -> `check_api_key_config`
- `API key missing` -> `check_api_key_config`
- `API key may be required` -> `check_api_key_config`
- `provider configuration missing` -> `check_provider_config`
- `model configuration missing` -> `check_model_config`
- `default model configuration missing` -> `check_default_model_config`
- `selected model configuration missing` -> `check_selected_model_config`
- `runtime not recognizing selected model` -> `check_selected_model_config`
- `nim is not running` -> `start_nim_runtime`
- `gpu runtime not enabled` -> `enable_gpu_runtime`
- `nvidia policy missing` -> `review_runtime_capabilities`

Priority order is:

- provider / API key / model
- NIM runtime
- GPU runtime enablement
- capability review

Remediation responses now include:

- `missing_requirements[]`
- `resolved_next_step`

Routing loop uses `resolved_next_step` before the older generic `next_step`, so the manager can stop with a more specific final state:

- `provider_not_ready`
- `nim_not_ready`
- `gpu_not_ready`
- `capability_limited`

This is still a transitional routing layer. `configure_provider`, `start_nim_runtime`, and `enable_gpu_runtime` are not yet fully automatic end-to-end remediations; they are structured branch targets for the next layer of automation.

Provider remediation notes:

- `configure_provider` now acts as a minimal provider dispatcher
- it collects structured provider signals, triggers `sense runtime start`, re-checks runtime status, and re-checks structured sandbox status
- it returns `provider_status` with:
  - `provider`
  - `model`
  - `api_key_required`
  - `api_key_present`
  - `required_api_keys`
  - `present_keys`
  - `missing_api_keys`
  - `api_key_check_mode`
  - `checked_sources`
  - `detected_keys`
  - `provider_config_present`
  - `provider_runtime_recognized`
  - `model_config_present`
  - `provider_source`
  - `provider_runtime_source`
  - `model_source`
  - `provider_ready`
  - `missing_requirements[]`

Current provider priority order is:

- `API key missing: ...` -> `check_api_key_config`
- `API key missing` -> `check_api_key_config`
- `API key may be required` -> `check_api_key_config`
- `provider configuration missing` -> `check_provider_config`
- `model configuration missing` -> `check_model_config`

The current signals are inferred conservatively from:

- structured sandbox status (`provider`, `model`)
- start result summary and key points
- `~/.openclaw/openclaw.json`
- environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_API_KEY`)

Provider source semantics are intentionally split:

- `provider_source`
  - where the selected provider value came from
  - one of `config`, `sandbox-status`, `start-result`, `runtime`, `unknown`
- `provider_runtime_source`
  - where runtime recognition came from
  - one of `sandbox-status`, `start-result`, `runtime`, `null`

Current `provider_runtime_recognized` is inferred from:

- structured sandbox status provider field
- runtime start summary / key points / raw output
- runtime status summary / key points / raw output

If config contains a provider but runtime signals do not recognize it yet, remediation returns:

- `provider_config_present = true`
- `provider_runtime_recognized = false`
- `missing_requirements` including `provider runtime not recognizing configured provider`

Model source semantics are intentionally split the same way:

- `model_source`
  - where the selected model value came from
  - one of `config`, `sandbox-status`, `start-result`, `runtime`, `unknown`
- `model_runtime_source`
  - where runtime recognition came from
  - one of `sandbox-status`, `start-result`, `runtime`, `null`

Current `model_runtime_recognized` is inferred from:

- structured sandbox status model field
- runtime start summary / key points / raw output
- runtime status summary / key points / raw output

If config contains a model but runtime signals do not recognize it yet, remediation returns:

- `model_config_present = true`
- `model_runtime_recognized = false`
- `missing_requirements` including `runtime not recognizing configured model`

Model remediation is now split into:

- `check_default_model_config`
  - verifies whether a default model exists in config
- `check_selected_model_config`
  - verifies whether the currently selected model exists and whether runtime recognizes it

Current `model_status` includes:

- `default_model`
- `default_model_source`
- `default_model_present`
- `selected_model`
- `selected_model_source`
- `selected_model_expected`
- `selected_model_expected_source`
- `selected_model_runtime`
- `selected_model_present`
- `selected_model_runtime_recognized`
- `selected_model_runtime_source`
- `selected_model_match`
- `selected_model_diff_reason`
- `model_ready`

Selected-model diff semantics:

- `selected_model_expected`
  - the configured model the manager expects runtime to use
  - currently derived from config-first signals
- `selected_model_runtime`
  - the model runtime appears to have selected
  - derived from sandbox status, start result, or runtime status
- `selected_model_match`
  - `true` when both values exist and match
  - `false` when both values exist and differ
  - `null` when one side is still unknown

Retry policy is intentionally conservative:

- if only `start-result` shows a selected model
  - the orchestration treats that as a one-time recheck signal
  - `retry_decision = recheck_runtime_status_once`
  - `selected_model_runtime_recognized` stays false until runtime status or sandbox confirms it
- if `start-result` and `runtime status` confirm the same selected model
  - `retry_decision = runtime_model_confirmed`
- if the same selected-model mismatch repeats
  - orchestration does not restart again
  - `retry_decision = skip_restart_repeated_mismatch`
- if runtime still does not expose a selected model
  - orchestration stops with `selected_model_not_ready`

Routing loop now acts as a state evaluator, not a final decision owner:

- it evaluates readiness, remediation, and retry metadata
- it returns `policy_input`
- it does not execute manager-owned next steps such as retry / stop / follow-up action

Manager policy table:

- `scripts/runtime/sense_runtime_manager_policy.py`
- `scripts/runtime/sense-runtime-manager-policy.sh`
- `scripts/runtime/sense_runtime_manager_signal_classifier.py`

The manager policy table consumes:

- `final_state`
- `next_step`
- `retry.retry_decision`
- `retry.retry_allowed`

and decides:

- whether to retry
- whether to stop
- what next manager action to run

Recommended separation:

- `sense_runtime_routing_loop.py`
  - evaluates runtime state and emits `policy_input`
- `sense_runtime_manager_policy.py`
  - owns retry / stop / next-step decisions

Current deterministic manager action matrix:

- `provider_api_key_missing`
  - `manager_action = configure_provider`
- `provider_config_missing`
  - `manager_action = configure_provider`
  - `next_step = check_provider_config`
- `provider_model_missing`
  - `manager_action = configure_provider`
  - `next_step = check_model_config`
- `provider_not_ready`
  - API key oriented provider diff
    - `manager_action = configure_provider`
    - `next_step = check_api_key_config`
  - provider recognition diff
    - `manager_action = configure_provider`
    - `next_step = check_provider_config`
  - runtime capability diff
    - `manager_action = start_nim_runtime` or `configure_gpu_runtime`
- `selected_model_not_ready` + `retry_decision = recheck_runtime_status_once`
  - `manager_action = retry_once`
- `selected_model_not_ready` + `retry_allowed = false`
  - `manager_action = configure_model`
  - `next_step = check_selected_model_config`
- `selected_model_mismatch` + repeated mismatch / `skip_restart_repeated_mismatch`
  - `manager_action = stop_and_surface_diff`
- `selected_model_mismatch` without repeated mismatch
  - provider-oriented mismatch
    - `manager_action = configure_provider`
    - `next_step = check_provider_config`
  - runtime confirmation still incomplete
    - `manager_action = retry_once`
    - `next_step = check_selected_model_config`
  - model-name mismatch
    - `manager_action = configure_model`
    - `next_step = check_selected_model_config`
- `gpu_not_ready`
  - `manager_action = configure_gpu_runtime`
- `nim_not_ready`
  - `manager_action = start_nim_runtime`
- `capability_limited`
  - `manager_action = review_runtime_capabilities`
- `default_model_missing`
  - `manager_action = configure_model`
  - `next_step = check_default_model_config`
- `selected_model_missing`
  - `manager_action = configure_model`
  - `next_step = check_selected_model_config`
- `model_not_ready`
  - `manager_action = configure_model`
  - `next_step = check_model_config`
- `ready_for_runtime_task`
  - `manager_action = run_runtime_task`

Manager policy output now includes:

- `manager_action`
- `manager_reason`
- `next_step`
- `policy_trace`

`policy_trace` identifies which deterministic rule fired and which fields matched, so the manager can explain why it retried, stopped, or promoted a runtime task.

States that still do not have a dedicated manager action remain on the `manual_review` fallback. This keeps the manager deterministic for known concrete remediation states while preserving a safe fallback for unknown or not-yet-automated states.

For model remediation, the manager now distinguishes:

- `selected_model_not_ready` with one allowed runtime-status recheck
  - `retry_once`
- `selected_model_not_ready` when retry is not allowed
  - `configure_model`
- `selected_model_mismatch` when the mismatch is not yet repeated
  - `configure_provider` when provider recognition signals are missing or the diff reason points at provider resolution
  - `retry_once` when runtime has not yet confirmed the selected model
  - `configure_model` for direct model-name mismatch
- `selected_model_mismatch` when the same diff repeats
  - `stop_and_surface_diff`
- `model_not_ready`
  - `configure_model`

This keeps retry behavior explicit while pushing persistent model issues back into model remediation instead of leaving them in the generic fallback.

Current selected-model mismatch split is intentionally minimal and uses manager-visible signals only:

- `selected_model_diff_reason`
- `selected_model_expected`
- `selected_model_runtime`
- `selected_model_runtime_recognized`
- `provider`
- `provider_runtime_recognized`

This keeps the routing evaluator unchanged while letting manager policy distinguish provider-side mismatch, model-name mismatch, and runtime-confirmation mismatch.

`provider_not_ready` is now split the same way with manager-visible structured signals:

- API key signals
  - `provider_status.api_key_required`
  - `provider_status.api_key_present`
  - `provider_status.missing_api_keys`
  - `provider_status.missing_requirements`
- provider recognition signals
  - `provider_status.provider_config_present`
  - `provider_status.provider_runtime_recognized`
  - `provider_status.missing_requirements`
- runtime capability signals
  - `gpu_status.gpu_ready`
  - `nim_status_info.nim_ready`
  - `provider_status.missing_requirements`

Priority order is intentionally:

- API key remediation
- provider recognition remediation
- runtime capability remediation

If none of those signals are present, the manager still falls back to the existing `provider_not_ready -> configure_provider` behavior, and unknown states continue to use `manual_review`.

Manager policy now uses a small signal classifier first and then applies the action matrix:

- `provider_api_key_issue`
- `provider_recognition_issue`
- `runtime_capability_issue_nim`
- `runtime_capability_issue_gpu`
- `selected_model_retry_issue`
- `selected_model_mismatch_issue`
- `selected_model_provider_issue`

The classifier reads manager-visible structured fields from `policy_input` only, including:

- `provider_status.*`
- `gpu_status.*`
- `nim_status_info.*`
- `retry.*`
- selected-model diff signals

This keeps routing evaluation unchanged while making the manager policy table thinner and easier to extend. The policy table now prefers `classified_issue` when choosing deterministic actions and only falls back to direct `final_state` handling for simpler states.

Classifier output now also includes:

- `primary_issue`
- `secondary_issues`
- `priority`
- `confidence`
- `fallback_action`

The current classifier uses a simple priority model:

- `provider_api_key_issue` -> `high`
- `provider_recognition_issue` -> `high`
- `runtime_capability_issue_nim` -> `medium`
- `runtime_capability_issue_gpu` -> `medium`
- `selected_model_retry_issue` -> `low`
- `selected_model_mismatch_issue` -> `medium`
- `selected_model_provider_issue` -> `high`

`secondary_issues` are intentionally minimal. They let the manager preserve extra context, such as:

- provider recognition with NIM capability pressure
- selected-model mismatch with provider-side weakness

Policy now chooses action from `primary_issue`, keeps `secondary_issues` in `policy_trace`, and can fall back to `fallback_action` when no deterministic rule matches.

Manager policy output is now two-stage:

- `manager_action`
  - main action for `primary_issue`
- `secondary_action`
  - optional follow-up action for `secondary_issues[0]`
- `secondary_next_step`
  - follow-up step paired with `secondary_action`
- `fallback_action`
  - safe fallback when confidence is low or no deterministic rule matches

Thin manager executor:

- `scripts/runtime/sense_runtime_manager_executor.py`
- `scripts/runtime/sense-runtime-manager-executor.sh`
- `scripts/runtime/sense_runtime_manager_task.py`
- `scripts/runtime/sense-runtime-manager-task.sh`

Current orchestration layers are:

- evaluator
- classifier
- policy
- executor

The executor is intentionally thin. It reads policy JSON and executes:

- `manager_action` + `next_step`
- then `secondary_action` + `secondary_next_step`

Before running the secondary action, the executor now applies a small safety gate based on the main action result:

- if `main_action.result.exit_code == 0`
  - secondary execution may continue
- if `main_action.result.exit_code == 0` but readiness or missing-requirement signals still look degraded
  - secondary execution continues with warning
- if `main_action.result.exit_code != 0`
  - secondary execution is skipped
- if `main_action.result.error` is present
  - secondary execution is skipped

Current warning signals are intentionally minimal and may include:

- `readiness == degraded`
- top-level `missing_requirements`
- nested `provider_status` / `gpu_status` / `nim_status_info` / `model_status` readiness flags staying false
- nested or top-level warning lists in the remediation result

This keeps follow-up remediation from running after a failed primary remediation step while still allowing warning-marked continuation when the main action succeeds but leaves degraded state behind.

Current execution mapping is:

- `configure_provider` -> `check_provider_config`
- `configure_model` -> `check_selected_model_config`
- `configure_gpu_runtime` -> `configure_gpu_runtime`
- `start_nim_runtime` -> `start_nim_runtime`
- `review_runtime_capabilities` -> `review_runtime_capabilities`
- `retry_once` -> `check_selected_model_config`
- `run_runtime_task` -> manager task helper -> Sense runtime `/execute`

`run_runtime_task` now uses a real task launcher instead of a placeholder. The manager executor passes a task payload into a thin helper, and that helper reuses the existing Sense runtime bridge contract to submit a NemoClaw job and wait for completion.

Minimal task payload shape:

```json
{
  "task": "analyze",
  "input": "Summarize current Sense runtime readiness.",
  "params": {
    "mode": "nemoclaw_job",
    "scope": "nemoclaw",
    "job_profile": "future-nemoclaw",
    "task_type": "status"
  }
}
```

Current behavior is intentionally conservative:

- the worker submission still uses the existing `heavy_task` runtime-plane contract
- manager task intent is carried through structured task payload fields
- `task_payload` is included in the executor report so the manager can see exactly what was launched
- after a successful main `run_runtime_task`, the executor performs one post-task evaluation pass through the existing manager classifier and policy
- post-task evaluation is one-shot only; it does not recursively execute the returned candidate
- if post-task confidence is below threshold or policy resolves to the same action/step again, the executor stops at evaluation and reports the candidate as blocked
- if the post-task candidate passes the safety checks, the executor may run that follow-up exactly once
- execution report includes:
  - `post_task_followup_executed`
  - `post_task_followup_blocked`
  - `post_task_followup_block_reason`
  - `post_task_followup_result`
  - `loop_convergence`

Execution report shape includes:

- `executor_state`
- `main_action`
- `secondary_action`
- `task_payload`
- `post_task_evaluation`
- `post_task_followup_executed`
- `post_task_followup_blocked`
- `post_task_followup_block_reason`
- `post_task_followup_result`
- `secondary_gate_decision`
- `secondary_gate_reason`
- `secondary_gate_warning`
- `warnings`
- `warning_count`
- `duration_sec`
- `exit_summary`
- `fallback_action`
- `policy_trace`

`exit_summary` currently includes:

- `main_exit_code`
- `secondary_executed`
- `secondary_exit_code`

If `confidence_gate_applied == true` or the plan resolves to a non-executing action such as `manual_review` or `stop_and_surface_diff`, the executor stops without calling runtime remediation.

Current post-task evaluation safety rules are:

- only after `main_action == run_runtime_task`
- only when the main task exits with `exit_code == 0`
- skipped for `failed` / `stopped` / non-zero exit cases
- confidence below threshold stops candidate promotion
- identical action/step output is blocked to avoid self-loops
- follow-up runs only when:
  - `next_action` and `next_step` are both present
  - confidence is at least `0.5`
  - the candidate is not the same action/step as the just-finished main action
  - the candidate is not the fallback action
  - the candidate is not a non-executing manager action such as `manual_review`

Current block reasons include:

- `same_action_step`
- `low_confidence`
- `incomplete_followup_candidate`
- `fallback_action`
- `non_executing_followup_action`

`loop_convergence` is observational only. It does not trigger a new retry or a third execution pass.

`loop_convergence_summary` is a lighter manager-facing projection of `remaining_issues`. It classifies a few common issue strings into classifier-compatible labels so the manager can pick the next likely fix from the report alone.

The executor now also emits a thin `manager_handoff` payload for the next manager turn. This is a report-to-input bridge only; it does not trigger another action by itself.

Manager handoff triage helper:

- `scripts/runtime/sense_runtime_manager_handoff_triage.py`
- `scripts/runtime/sense-runtime-manager-handoff-triage.sh`
- `scripts/runtime/sense_runtime_manager_handoff_seed.py`
- `scripts/runtime/sense-runtime-manager-handoff-seed.sh`
- `scripts/runtime/sense_runtime_manager_policy_shortcut.py`
- `scripts/runtime/sense-runtime-manager-policy-shortcut.sh`
- `scripts/runtime/sense_runtime_manager_entry.py`
- `scripts/runtime/sense-runtime-manager-entry.sh`
- `scripts/runtime/sense_runtime_manager_dispatch.py`
- `scripts/runtime/sense-runtime-manager-dispatch.sh`
- `scripts/runtime/sense_runtime_manager_runtime_entry.py`
- `scripts/runtime/sense-runtime-manager-runtime-entry.sh`
- `scripts/runtime/sense_runtime_manager_policy_bridge.py`
- `scripts/runtime/sense-runtime-manager-policy-bridge.sh`

This helper is intentionally lightweight. It reads `manager_handoff` and decides whether the next manager turn should:

- use the handoff directly
- treat it as a hint only
- rerun the full evaluator

Current confidence rule is:

- `summary_confidence >= 0.7`
  - `use_handoff`
- `0.5 <= summary_confidence < 0.7`
  - `hint_only`
- `< 0.5`
  - `rerun_full_evaluator`

Failed or stopped handoffs also fall back to `rerun_full_evaluator`.

Manager entry now uses handoff triage as a thin pre-check before the full evaluator:

- `use_handoff`
  - accept `suggested_next_step` as the provisional next move
  - do not run the full evaluator
  - build a lightweight handoff seed and a recommended action from the suggested next step
  - build a lightweight policy shortcut plan from the seed when confidence is high
- `hint_only`
  - run the full evaluator
  - keep handoff fields as supplemental context in the entry result
- `rerun_full_evaluator`
  - ignore the handoff shortcut and run the full evaluator normally

This keeps the handoff as a next-turn hint only. It does not add another runtime loop.

The lightweight handoff seed is intentionally minimal. It is not a replacement for the full evaluator; it is a high-confidence shortcut for the next manager turn.

The lightweight policy shortcut is also intentionally minimal. It exists only for high-confidence `use_handoff` cases, returns a minimal `manager_action` / `next_step` pair, and does not replace the full evaluator.

The manager dispatch layer can now connect the shortcut directly to the thin executor:

- if `shortcut_used == true`
  - dispatch converts the shortcut manager plan into a minimal executor policy
  - dispatch sends that policy directly to the thin manager executor
- if `shortcut_used == false`
  - dispatch falls back to the existing full evaluator -> manager policy -> executor path

This is still a shortcut only. It does not add another loop, and it does not replace the full evaluator path when shortcut confidence is not high enough.

The manager runtime entrypoint now chains entry and dispatch into a single command:

- if a high-confidence handoff produces a shortcut plan
  - manager entry returns `use_handoff`
  - dispatch selects `shortcut_executor`
- otherwise
  - manager entry falls back to `hint_only` or `rerun_full_evaluator`
  - dispatch selects the normal full-evaluator path

This keeps the architecture layered while letting the manager start from a single runtime entry command.

The manager policy bridge adds one more thin shortcut layer for high-confidence handoff paths:

- if manager entry returns a valid shortcut plan
  - the bridge converts it into a lightweight manager policy outcome
  - runtime entry can pass that outcome directly to the thin executor
- if the shortcut plan is not usable
  - the bridge stays inactive
  - runtime entry falls back to the normal dispatch path

This bridge is not a replacement for the full evaluator. It is only a high-confidence shortcut that keeps the normal path intact.

The unified runtime entrypoint now also emits a top-level path summary:

- `path_taken`
  - human-readable route taken through handoff, triage, shortcut, bridge, or full evaluator
- `used_handoff`
  - whether a handoff payload was present at entry
- `used_shortcut`
  - whether a shortcut path was actually used
- `used_bridge`
  - whether the lightweight policy bridge was used
- `used_full_evaluator`
  - whether the normal full-evaluator path was taken

This is observability only. It does not add retries or another runtime loop.

Additional top-level observability fields are also included:

- `decision_trace_id`
  - short per-run trace identifier for joining entry, dispatch, and executor logs
- `entry_trace_span_id`
  - span id for the manager entry layer
- `dispatch_trace_span_id`
  - span id for the dispatch layer
- `dispatch_trace_parent_span_id`
  - parent span id pointing back to `entry_trace_span_id`
- `executor_trace_span_id`
  - span id for the executor layer
- `executor_trace_parent_span_id`
  - parent span id pointing back to `dispatch_trace_span_id`
- `entry_duration_sec`
  - time spent in manager entry
- `dispatch_duration_sec`
  - time spent in dispatch or bridge routing
- `executor_duration_sec`
  - time spent in the direct executor call when the shortcut path is used
- `path_tags`
  - short machine-friendly tags such as `handoff`, `triage:use_handoff`, `shortcut`, `bridge`, `executor`, `full_evaluator`, `failed`, or `stopped`
- `path_codes`
  - short uppercase machine-readable codes such as `HANDOFF`, `TRIAGE_USE`, `SHORTCUT`, `BRIDGE`, `FULL_EVAL`, `EXECUTOR`, `FAILED`, or `STOPPED`
- `path_signature`
  - compact string form of path codes using `CODE1>CODE2>CODE3`
- `error_code`
  - normalized top-level code such as `NONE`, `UNAUTHORIZED`, `TIMEOUT`, `RUNTIME_SUBMIT_FAILED`, `EXECUTOR_STOPPED`, or `EXECUTOR_FAILED`
- `error_detail_code`
  - finer-grained code such as `AUTH_401`, `AUTH_TOKEN_MISSING`, `TIMEOUT_ENTRY`, `TIMEOUT_EXECUTOR`, `SUBMIT_HTTP_4XX`, `SUBMIT_HTTP_5XX`, `EXECUTOR_STOP_CONFIDENCE_GATE`, or `EXECUTOR_STOP_MANUAL_REVIEW`
- `error_source_layer`
  - normalized failure source such as `ENTRY`, `DISPATCH`, `EXECUTOR`, `RUNTIME_BRIDGE`, or `NONE`
- `error_stage`
  - finer-grained failure stage such as `TRIAGE`, `BRIDGE`, `DISPATCH`, `REMEDIATION`, `TASK_SUBMIT`, `TASK_POLL`, `POST_TASK_FOLLOWUP`, `EXECUTOR_GATE`, or `NONE`
- `recovery_hint`
  - short operational hint such as `check_token`, `check_runtime_submit_path`, `check_runtime_poll_path`, `check_executor_gate`, `check_bridge_mapping`, `check_dispatch_input`, `check_triage_input`, or `no_action_needed`
- `recovery_priority`
  - short priority label such as `immediate`, `high`, `medium`, `low`, or `none`
- `recovery_rank`
  - numeric sort value for priority where larger numbers mean higher urgency, such as `100`, `75`, `50`, `25`, or `0`
- `recovery_bucket`
  - coarse aggregation bucket such as `auth`, `runtime_submit`, `runtime_poll`, `control_plane`, `executor_gate`, `config_mapping`, or `none`
- `recovery_owner`
  - coarse responsibility owner such as `auth`, `runtime`, `manager_control_plane`, `config`, or `none`
- `recovery_actionable`
  - boolean flag indicating whether a human should look at the issue now
- `recovery_vector`
  - compact aggregation object that bundles `bucket`, `owner`, `actionable`, and `rank`
- `recovery_signature`
  - compact string form of the recovery vector using `{bucket}:{owner}:{actionable}:{rank}`
- `summary_counters`
  - compact counters such as `warning_count`, `remaining_issue_count`, `secondary_action_count`, `followup_executed_count`, and `path_depth`
- `entry_status`
  - status of the manager entry layer
- `bridge_status`
  - status of the lightweight policy bridge layer
- `dispatch_status`
  - status of the dispatch layer
- `executor_status`
  - status reported by the thin manager executor

These fields are for observability and aggregation only. They do not change runtime behavior.

The same `decision_trace_id` is also propagated end-to-end through the runtime entry output, the executor's `execution_report`, and the emitted `manager_handoff`, while each layer gets its own `trace_span_id` plus parent span linkage for a lightweight trace tree. `manager_handoff` and `feedback_memory` also carry compact `path_codes`, `path_signature`, `error_code`, `error_detail_code`, `error_source_layer`, `error_stage`, `recovery_hint`, `recovery_priority`, `recovery_rank`, `recovery_bucket`, `recovery_owner`, `recovery_actionable`, `recovery_vector`, and `recovery_signature` for lightweight aggregation and faster operational triage.

For log aggregation and dashboard use, `sense-runtime-log-aggregate.sh` provides a thin read-only view over runtime entry observability records. It groups by `route_signature`, reports per-route counts, latest occurrence timestamp, per-owner counts, actionable counts, max recovery rank, an owner x bucket cross-tab summary, an owner x bucket x actionable summary, an owner x bucket x priority-band summary, both fixed-grid and compact `priority_heatmap` views derived from the same filtered record set, a `route_severity_compact` list for route-level notification-style ranking, and `notification_digest_summary` for one-line grouped daily-digest and thread-summary rows keyed by `notification_group_key`. `priority_heatmap.score` is a weighted sum (`immediate=100`, `high=75`, `medium=50`, `low=25`, `none=0`) and `priority_heatmap.band` is the strongest priority band present for that owner/bucket cell. `priority_heatmap_compact` keeps only cells with `score > 0`, which is useful for lists, CLI output, and notifications, while `route_severity_compact` keeps only routes with `max_recovery_rank > 0`, ranks them by route-level severity, emits `notification_signature` as a shorter `bucket.band.path_signature` key for notification templates, Slack aggregation, and dedupe, emits `notification_group_key` as a coarser `bucket.band.path_group` key for Slack thread grouping and daily digests, emits `notification_title` as a human-readable label for notification and list display, emits `notification_title_short` as a shorter Slack-subject or list-header label, emits `digest_title` as a daily-digest-oriented heading that is more general than the route-level notification titles, emits `digest_sort_key` as a machine-oriented stable sort key for severity + recency + count ordering in daily digests and Slack summaries, emits `digest_bucket_total` so each digest row can show its own grouped count alongside the total filtered-set count for the same recovery bucket, emits `digest_bucket_share` so each digest row can show its own share of that bucket, emits `digest_bucket_percent` as a preformatted percentage string for UI-friendly bucket-share display, emits `digest_bucket_dominance_band` as a thin `dominant/major/split/minor` categorization for UI-friendly bucket-share color coding, emits `digest_bucket_palette_key` as a UI-oriented palette hint (`danger/warning/accent/muted`) derived from that dominance band, emits `digest_bucket_badge` as a short display-ready badge label (`Dominant/Major/Split/Minor`) derived from the same dominance band, emits `digest_bucket_badge_short` as a compact badge label (`DOM/MAJ/SPL/MIN`) for narrow tables and mobile UI, emits `digest_bucket_badge_order` as a numeric strength hint (`dominant=4`, `major=3`, `split=2`, `minor=1`, `unknown=0`) for compact-table and mobile sorting, emits `digest_bucket_badge_tuple` as a compact UI-drawing structure that bundles the badge palette, short label, and order while keeping the original top-level fields for backward compatibility, emits `digest_bucket_ui_hint` as a higher-level UI helper that bundles the badge tuple, percent string, and leader flag so cards and mobile lists can render bucket state from one nested structure, emits `digest_bucket_ui_hint_compact` as a one-line compact string (`BADGE PERCENT` with an optional leader star) for notifications and ultra-narrow cards, emits `digest_bucket_ui_hint_line2` as a second-line helper string (`PERCENT • Leader/Follower`) for two-line cards, emits `digest_bucket_ui_hint_tokens` as a fixed three-token array (`[badge_short, percent, leader_label]`) so UI code can choose its own line breaks and ordering without reparsing strings, emits `digest_bucket_ui_layouts` as a layout-oriented structure that bundles `badge`, `hint`, `compact`, `line2`, `tokens`, and `meta` so UI code can consume all supported bucket-display variants plus lightweight `leader/rank/palette/order/percent/share/dominance_band` metadata from one nested object while the original top-level fields remain for backward compatibility, emits `digest_bucket_rank` so the top group inside each recovery bucket is easy to identify, emits `digest_bucket_leader` as a direct true/false flag for the rank-1 row in each recovery bucket, and emits `digest_bucket_leader_count` so all rows in the same bucket can carry the filtered-set count of leader rows for chaptering and representative-group summaries. `top_n` trims only the per-route detail list; the cross-tab and derived summaries stay based on the full filtered set. This helper is observational only and does not execute runtime work.

`digest_bucket_ui_layouts.meta` also mirrors `digest_bucket_badge_short` as `badge_short`, so UI code can read palette, leader, rank, order, percent, share, dominance band, and compact badge label from one nested metadata object without losing the original top-level fields.

`digest_bucket_ui_layouts.meta` also exposes `leader_label` (`Leader` or `Follower`) so UI code can render the human-readable leader state from the same nested metadata object without re-deriving it from the boolean flag.

`digest_bucket_ui_layouts.meta` also exposes `leader_symbol` (`★` or empty string) so UI code can render the compact leader marker from the same nested metadata object without re-deriving it from the boolean flag.

`digest_bucket_ui_layouts.meta` also exposes `leader_compact` (`Leader ★` or `Follower`) so UI code can render the final leader/follower label from the same nested metadata object without re-assembling text and symbol fragments.

`digest_bucket_ui_layouts.meta` also exposes `leader_tokens` (`["Leader", "★"]` or `["Follower"]`) so UI code can render or rearrange the final leader/follower display tokens from the same nested metadata object without reparsing the compact label.

`digest_bucket_ui_layouts.meta` also exposes `leader_parts` as a small nested structure with `label`, `symbol`, `compact`, and `tokens`, so UI code can consume all leader-specific display variants from one place without losing the existing flat `leader_*` fields.

`digest_bucket_ui_layouts.meta` also exposes `display_parts` as a shallow wrapper over `badge_parts` and `leader_parts`, so UI code can read both display-oriented substructures from one `meta.display_parts` entry without extra recomposition.

`digest_bucket_ui_layouts.meta` also exposes `summary_parts` as a shallow wrapper over `display_parts`, `percent`, and `share`, so UI code can read display-oriented substructures plus the formatted and numeric bucket-share values from one `meta.summary_parts` entry without extra recomposition.

UI consumers should prefer `digest_bucket_ui_layouts.meta.summary_parts` as the first rendering entry for digest badge/leader/percent/share display before falling back to flatter fields. Preview and list/card rendering should share the same shallow selector so the same summary entrypoint works across both views. `render_parts` is intentionally not introduced yet; the current goal is to use `summary_parts` as the primary UI entrypoint.

## NemoClaw Control Via Slack

The current digest structures are intended to stay reusable across preview, list/card UI, and Slack notifications without introducing a larger render contract. The initial position is:

- OpenClaw remains the management/control-plane home
- NemoClaw Control via Slack starts as an execution visibility layer
- Slack is the first mobile-friendly operating surface
- the existing digest structures are reused as shallow display contracts
- `render_parts` is still intentionally not introduced

Slack notification/event minimum set:

- `job_queued`
  - sent when a NemoClaw async job is accepted and enters `queued`
  - required: `job_id`, `status`, `target`
  - optional: `stage`, `message`, `notification_group_key`
  - digest: optional, normally omitted unless a digest row is already available
- `job_running`
  - sent when a queued job transitions to `running`
  - required: `job_id`, `status`
  - optional: `stage`, `message`
  - digest: optional
- `job_done`
  - sent when a job finishes successfully
  - required: `job_id`, `status`
  - optional: `summary`, `key_points`, `suggested_next_action`, `notification_digest_summary`
  - digest: yes when digest rows are available
- `job_failed`
  - sent when a job ends in `failed`
  - required: `job_id`, `status`
  - optional: `message`, `error_code`, `error_detail_code`, `notification_digest_summary`
  - digest: optional, use only if a digest row helps explain the failure
- `digest_ready`
  - sent when `notification_digest_summary` is emitted for operator review
  - required: `notification_digest_summary`
  - optional: `digest_sort_key`, `notification_group_key`
  - digest: yes, this event is digest-first
- `digest_alert`
  - sent when a digest row represents the current top alertable issue
  - required: `notification_digest_summary[0]`
  - optional: `sample_error_code`, `route_signature`, `notification_group_key`
  - digest: yes

Slack display contract minimum:

- primary source:
  - `notification_digest_summary`
  - `digest_title`
  - `digest_sort_key`
  - `digest_bucket_ui_layouts.meta.summary_parts`
- shallow fallback only when `summary_parts` is missing:
  - `digest_bucket_ui_layouts.meta.display_parts`
  - `digest_bucket_ui_layouts.meta.badge_parts`
  - `digest_bucket_ui_layouts.meta.leader_parts`
  - `digest_bucket_ui_layouts.meta.percent`
  - `digest_bucket_ui_layouts.meta.share`
  - top-level `digest_bucket_percent`
  - top-level `digest_bucket_share`

Minimal Slack row contract:

- line 1:
  - `title`
- line 2:
  - `badge.short | percent | leader.compact`
- optional suffix:
  - `share`
  - `sample_error_code`
  - `notification_group_key` or `route_signature`

Example shallow formatting target:

```text
Auth failures (immediate)
MAJ | 50.0% | Leader ★ | share=0.5
```

Slack command minimum set:

- `/nemoclaw recent`
  - input: optional count/window
  - returns: recent jobs and latest state changes
  - digest: optional
  - current digest structures are sufficient for compact summaries; additional recent-job sourcing is still needed
- `/nemoclaw job <id>`
  - input: `job_id`
  - returns: status, stage, message, result summary if present
  - digest: optional
  - current digest structures help only when the job result includes `notification_digest_summary`
- `/nemoclaw failures`
  - input: optional recent window
  - returns: recent failed jobs and top failure summaries
  - digest: yes when digest rows exist
  - current digest structures are sufficient for the display layer
- `/nemoclaw digest`
  - input: optional filter such as owner/bucket/top-n
  - returns: latest digest summary row for operator review in the current minimum implementation
  - digest: yes
  - current digest structures are the primary payload, sourced from the latest cached `notification_digest_summary`
- `/nemoclaw gpu`
  - input: optional sandbox/runner target
  - returns: current GPU/runtime readiness summary
  - digest: usually no
  - additional GPU/runtime status sourcing is still needed beyond the digest contract
- `/nemoclaw help`
  - input: none
  - returns: supported commands and one-line intent
  - digest: no

Implementation guidance for the first Slack layer:

- use `summary_parts` as the primary display entrypoint
- keep formatting shallow and string-oriented
- do not add a new loop or retry layer
- do not change runtime orchestration semantics
- treat Slack as an execution visibility/output surface first, not a new control-plane authority

Current first-pass wiring is intentionally limited to:

- `digest_ready`
- `job_failed`
- `job_done`

These notifications are emitted from the NemoClaw runner completion path and rendered through the same shallow digest selector/formatter chain used by preview-oriented consumers. This phase prioritizes execution visibility only; `job_queued`, `job_running`, and `digest_alert` stay for later phases.

`digest_ready` naturally fires when the completion payload includes
`notification_digest_summary`. The smallest current verification path is `heavy_task`
with `mode=nemoclaw_job` plus `params.digest_ready_probe=true`, which returns one digest
item whose primary display entrypoint remains
`digest_bucket_ui_layouts.meta.summary_parts`.

The first `/nemoclaw digest` command stays intentionally shallow: it reads the latest cached
`notification_digest_summary`, formats the first item with the shared Slack digest formatter,
and returns that text directly. This keeps the post-notification check path aligned with the
same `summary_parts` contract used by preview and Slack notifications.

`/nemoclaw job <id>` is the matching per-job check path: it reads the existing Sense job
status source, formats `notification_digest_summary` through the same Slack digest formatter
when present, and otherwise returns a minimal `status / exit_code / error / summary` text.

For direct Slack slash command routing, the first-pass bridge stays intentionally thin:

- enable `channels.slack.slashCommand.enabled=true` (or Slack native commands)
- expose `/nemoclaw` as a Slack slash command name
- let the Slack native command surface pass `/nemoclaw digest` and `/nemoclaw job <id>`
  into the existing plugin command handler
- let `/nemoclaw recent` reuse the existing runner journal plus job-status source for a
  shallow recent-job list without introducing a new persistence layer

This keeps the Slack layer aligned with the existing `summary_parts` formatter path instead
of introducing a separate command-specific render contract.

`/nemoclaw recent` is the matching lightweight list view: it reads the most recent job ids
from the existing runner journal, looks up each job through the existing job-status source,
formats digest-bearing rows with the shared Slack digest formatter, and otherwise returns a
short `error / summary / status` line for each recent job.

`/nemoclaw failures` is the matching filtered view: it reuses the same recent-job source and
job-status lookup as `/nemoclaw recent`, but keeps only jobs with `result.error` or
`result.exit_code != 0`. Digest-bearing failed jobs still render through the shared Slack
digest formatter; non-digest failures prefer `error`, then `summary`, then minimal status.

The runtime entrypoint now also emits a lightweight feedback layer for the next turn:

- `feedback_summary`
  - `decision_quality`
  - `shortcut_accuracy`
  - `fallback_triggered`
  - `fallback_reason`
  - `loop_efficiency`
- `feedback_memory`
  - `last_decision_quality`
  - `last_primary_issue`
  - `last_success_action`
  - `last_path_codes`
  - `last_error_code`
  - `last_error_detail_code`

This feedback is observational only. It does not add retries or a new loop. The manager entry can read `feedback_memory` and apply lightweight gating rules at the next turn:

- `poor`
  - reroute to the full evaluator
- `good + same primary issue`
  - keep the shortcut path
  - add `feedback_gate_mode = annotate_only`
- `degraded + same action repeated`
  - reroute to the full evaluator to avoid repeating the same shortcut path

Current convergence states are:

- `resolved`
  - follow-up reached ready state without remaining warnings or missing requirements
- `partially_resolved`
  - follow-up completed but degraded signals, warnings, or missing requirements remain
- `unresolved`
  - follow-up failed, returned a non-zero exit code, or regressed readiness
- `no_followup`
  - no follow-up action was executed

This second-order evaluation is intentionally report-only to avoid adding another loop layer.

Current `loop_convergence_summary` mapping is intentionally minimal:

- `nim is not running` -> `runtime_capability_issue_nim`
- `gpu runtime not enabled` -> `runtime_capability_issue_gpu`
- `provider runtime not recognizing configured provider` -> `provider_recognition_issue`
- `API key missing: ...` -> `provider_api_key_issue`
- `runtime selected model differs from configured selected model` -> `selected_model_mismatch_issue`
- `runtime not recognizing selected model` -> `selected_model_retry_issue`

The summary currently exposes:

- `primary_remaining_issue`
- `secondary_remaining_issues`
- `suggested_next_step`
- `summary_confidence`

Current `manager_handoff` shape is intentionally flat:

- `handoff_version`
- `source`
- `executor_state`
- `loop_convergence_state`
- `primary_remaining_issue`
- `secondary_remaining_issues`
- `suggested_next_step`
- `summary_confidence`
- `last_main_action`
- `last_secondary_action`
- `notes`

Current confidence gate is intentionally small:

- if `confidence < 0.5`
  - `secondary_action = null`
  - `confidence_gate_applied = true`

Routing loop can now stop more specifically as:

- `default_model_missing`
- `selected_model_missing`
- `selected_model_not_ready`
- `selected_model_mismatch`

Provider-specific API key mapping is intentionally minimal:

- `openai` -> `OPENAI_API_KEY`
- `anthropic` -> `ANTHROPIC_API_KEY`
- `nvidia` / `nim` / GPU-runtime hints -> `NVIDIA_API_KEY`
- `ollama` -> no mandatory key by itself, unless runtime/start output indicates a stronger provider-specific key requirement

Only key presence is returned. Values are never logged or returned.

Routing loop behavior change:

- if remediation resolves to `check_api_key_config`, the loop runs that check once
- if remediation resolves to `check_provider_config`, the loop runs that check once
- if remediation resolves to `check_model_config`, the loop runs that check once
- if remediation resolves to `check_api_key_config`, loop stops with `final_state = provider_api_key_missing`
- if remediation resolves to `check_provider_config`, loop stops with `final_state = provider_config_missing`
- if remediation resolves to `check_model_config`, loop stops with `final_state = provider_model_missing`

This is still a transitional provider remediation layer. It does not yet write provider credentials or model defaults automatically; it only identifies the missing provider sub-step in structured form.

NIM remediation notes:

- `start_nim_runtime` now performs a minimal real remediation attempt
- it collects current structured sandbox signals, triggers `sense runtime start`, re-checks runtime status, and re-checks structured sandbox status
- it returns `nim_status_info` with:
  - `sandbox_name`
  - `phase`
  - `nim_status`
  - `gpu_enabled`
  - `runtime_name`
  - `openshell_status`
  - `policy_names`
  - `provider`
  - `model`
  - `provider_ready`
  - `gpu_ready`
  - `runtime_connected`
  - `start_attempted`
  - `nim_ready`
  - `missing_requirements[]`

Current `nim_ready` rule is intentionally minimal:

- `phase == Ready`
- `openshell_status == connected`
- `nim_status == running`

`provider` and `model` may still be `unknown`; they are used to build `missing_requirements`, not to make `nim_ready` fail by themselves.

Routing loop behavior change:

- if `check_gpu_runtime` resolves to `start_nim_runtime`, the loop now runs that remediation once
- if `nim_status_info.nim_ready == false`, the loop stops with `final_state = nim_not_ready`
- if the follow-up missing requirements resolve to `configure_provider`, the loop stops with `final_state = provider_not_ready`
