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
