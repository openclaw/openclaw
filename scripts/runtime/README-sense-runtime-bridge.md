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
- `sense_runtime_dispatcher.py`
  - minimal dispatcher for manager decisions
  - consumes `details.sandbox_status` only
  - does not re-parse text
- `sense-runtime-dispatcher.sh`
  - shell entrypoint for dispatcher use in workflows or manager chains

Structured sandbox-status fields used by the dispatcher:

- `phase`
- `gpu_enabled`
- `policy_names`
- `nim_status`
- `runtime_name`
- `openshell_status`

Dispatcher rules:

- `phase != Ready` -> `readiness=not_ready`, `recommended_action=wait_for_runtime_ready`
- `gpu_enabled == false` -> degrade readiness and recommend `check_gpu_runtime`
- `nim_status != running` -> degrade readiness and recommend `check_runtime_provider`
- missing required policies -> `readiness=limited` or degraded with `review_runtime_capabilities`
- `provider` and `model` may still be `unknown`; dispatcher does not fail on those fields

Dispatcher example:

```bash
scripts/runtime/sense-runtime-manager-tool.sh --intent "sense sandbox status" --token "$SENSE_WORKER_TOKEN" --sandbox-name sense-wsl-agent \
  | scripts/runtime/sense-runtime-dispatcher.sh
```

Example output:

```json
{
  "readiness": "degraded",
  "recommended_action": "check_runtime_provider",
  "reasons": ["gpu is not enabled", "nim_status is not running"]
}
```
