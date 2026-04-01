# Sense Runtime Tool

Formal runtime-plane entrypoints for the T550 control plane live in:

- `scripts/runtime/sense_runtime_bridge.py`
- `scripts/runtime/sense-runtime.sh`
- `scripts/runtime/sense-runtime-tool.sh`
- `scripts/runtime/sense-runtime-intent.sh`

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
  - manager / bot / workflow execution entrypoint
  - prints the final structured `result` object only
- `sense-runtime-intent.sh`
  - intent mapper for manager / bot / workflow
  - turns natural control-plane intents into runtime actions
  - currently supports `sense runtime status`, `sense runtime start`, `sense runtime stop`, and `sense sandbox status`

Supported actions:

- `status`
- `start`
- `stop`
- `sandbox-status`

Manager-friendly examples:

```bash
scripts/runtime/sense-runtime-intent.sh "sense runtime status" --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-intent.sh "sense runtime start" --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-intent.sh "sense runtime stop" --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-intent.sh "sense sandbox status" --token "$SENSE_WORKER_TOKEN" --sandbox-name sense-wsl-agent
```

Compatibility note:

- `scripts/dev/sense_runtime_bridge.py` remains as a thin shim so existing one-off validation commands do not break
- new workflow or manager integrations should call `scripts/runtime/sense-runtime-intent.sh`
- `scripts/runtime/sense-runtime-tool.sh` remains the stable execution boundary for result-only JSON

Control plane / runtime plane split:

- T550 OpenClaw = control plane and orchestration
- Sense worker + Sense WSL NemoClaw = runtime plane and execution

Operational notes:

- `401 unauthorized` is returned directly when the shared token is wrong
- `start` may still be functionally limited until provider configuration such as NVIDIA API keys is complete
- `sandbox-status` is still a text-heavy runtime report, but the bridge now strips ANSI and keeps it readable for manager-side consumption
- if manager or bot needs richer sandbox fields later, `sandbox-status` can be further structured without changing the bridge path

Natural next step:

- wire `scripts/runtime/sense-runtime-intent.sh` into manager or bot tool dispatch so intents like `sense runtime status` or `sense sandbox status` become a simple subprocess call
