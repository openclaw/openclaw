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

Responsibility split:

- `sense_runtime_bridge.py`
  - submit to Sense worker
  - poll `/jobs/{job_id}`
  - preserve structured result semantics
  - sanitize `sandbox-status` text so manager and bot flows do not have to parse ANSI noise
- `sense-runtime.sh`
  - operator-facing shell entrypoint
  - prints the full completed job envelope
- `sense-runtime-tool.sh`
  - runtime execution entrypoint
  - prints the final structured `result` object only
- `sense-runtime-intent.sh`
  - intent mapper for shell/operator use
  - turns natural control-plane intents into runtime actions
- `sense_runtime_subprocess_tool.py`
  - explicit-action subprocess wrapper
  - safely builds argv and delegates to `sense-runtime-intent.sh`
- `sense-runtime-subprocess-tool.sh`
  - executable shell entrypoint for workflow subprocess calls
- `sense_runtime_manager_tool.py`
  - manager-facing tool wrapper
  - accepts natural-language intent or explicit action
  - returns manager-friendly JSON
  - for `sandbox-status`, extracts a structured `details.sandbox_status` block
- `sense-runtime-manager-tool.sh`
  - executable shell entrypoint for manager and bot subprocess calls

Supported actions:

- `status`
- `start`
- `stop`
- `sandbox-status`

Action to intent mapping:

- `status` -> `sense runtime status`
- `start` -> `sense runtime start`
- `stop` -> `sense runtime stop`
- `sandbox-status` -> `sense sandbox status`

Manager-friendly examples:

```bash
scripts/runtime/sense-runtime-manager-tool.sh --intent "sense runtime status" --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-manager-tool.sh --intent "sense runtime start" --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-manager-tool.sh --intent "sense runtime stop" --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-manager-tool.sh --intent "sense sandbox status" --token "$SENSE_WORKER_TOKEN" --sandbox-name sense-wsl-agent
```

Compatibility note:

- `scripts/dev/sense_runtime_bridge.py` remains as a thin shim so existing one-off validation commands do not break
- `scripts/runtime/sense-runtime-intent.sh` remains the natural-language shell entrypoint
- `scripts/runtime/sense-runtime-subprocess-tool.sh` remains the stable explicit-action subprocess boundary
- manager / bot integrations should prefer `scripts/runtime/sense-runtime-manager-tool.sh`

Control plane / runtime plane split:

- T550 OpenClaw = control plane and orchestration
- Sense worker + Sense WSL NemoClaw = runtime plane and execution

Manager tool path:

- manager / bot / workflow
- -> `scripts/runtime/sense-runtime-manager-tool.sh`
- -> `scripts/runtime/sense_runtime_manager_tool.py`
- -> `scripts/runtime/sense-runtime-subprocess-tool.sh`
- -> `scripts/runtime/sense_runtime_subprocess_tool.py`
- -> `scripts/runtime/sense-runtime-intent.sh`
- -> `scripts/runtime/sense-runtime-tool.sh`
- -> `scripts/runtime/sense_runtime_bridge.py`
- -> Sense worker
- -> `nemoclaw_runner.py`
- -> Sense WSL NemoClaw runtime

Structured sandbox-status fields:

- `sandbox_name`
- `sandbox_id`
- `namespace`
- `phase`
- `provider`
- `model`
- `gpu_enabled`
- `policy_names`
- `nim_status`
- `runtime_name`
- `openshell_status`

If a field cannot be extracted reliably, the manager tool returns `unknown`, `null`, or `[]` instead of failing.

Operational notes:

- `401 unauthorized` is returned directly when the shared token is wrong
- `start` may still be functionally limited until provider configuration such as NVIDIA API keys is complete
- `sandbox-status` still keeps the original payload in `details.raw_output`
- if manager or bot needs richer dispatch decisions later, `details.sandbox_status` should be the preferred input instead of parsing text again
