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
