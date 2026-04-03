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
- `fallback_action`
  - safe fallback when confidence is low or no deterministic rule matches

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
