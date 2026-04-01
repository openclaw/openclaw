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

Decision step flow:

- manager requests `sense sandbox status`
- `sense-runtime-manager-tool.sh` returns structured `details.sandbox_status`
- `sense-runtime-dispatcher.sh` evaluates readiness from structured fields only
- `sense-runtime-decision.sh` wires the two together and returns:
  - `readiness`
  - `recommended_action`
  - `reasons`
  - `next_step`

Dispatcher fields used:

- `phase`
- `gpu_enabled`
- `policy_names`
- `nim_status`
- `runtime_name`
- `openshell_status`

Decision rules:

- `readiness == ready`
  - next runtime task may proceed
  - `next_step = run_runtime_task`
- `readiness == degraded`
  - route to provider or GPU checks
  - examples: `check_runtime_provider`, `check_gpu_runtime`
- `readiness == not_ready`
  - re-check or start the runtime first
  - `next_step = sense_runtime_status`
- `provider` and `model` may remain `unknown`
  - manager does not use those fields yet for readiness decisions

Example:

```bash
scripts/runtime/sense-runtime-decision.sh \
  --token "$SENSE_WORKER_TOKEN" \
  --sandbox-name sense-wsl-agent
```

Current observed result on Sense:

```json
{
  "readiness": "degraded",
  "recommended_action": "check_runtime_provider",
  "reasons": ["gpu is not enabled", "nim_status is not running"],
  "next_step": "sense_runtime_start"
}
```

Natural next extension:

- wire `check_runtime_provider` to a remediation step
- wire `check_gpu_runtime` to a GPU health probe
- wire `wait_for_runtime_ready` to retry / backoff around `sense runtime status`
