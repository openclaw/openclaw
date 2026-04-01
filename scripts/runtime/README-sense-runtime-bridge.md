# Sense Runtime Tool

Formal runtime-plane entrypoints for the T550 control plane live in:

- `scripts/runtime/sense_runtime_bridge.py`
- `scripts/runtime/sense-runtime.sh`
- `scripts/runtime/sense-runtime-tool.sh`

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
  - manager / bot / workflow entrypoint
  - prints the final structured `result` object only

Supported actions:

- `status`
- `start`
- `stop`
- `sandbox-status`

Manager-friendly examples:

```bash
scripts/runtime/sense-runtime-tool.sh status --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-tool.sh start --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-tool.sh stop --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-tool.sh sandbox-status --token "$SENSE_WORKER_TOKEN" --sandbox-name sense-wsl-agent
```

Compatibility note:

- `scripts/dev/sense_runtime_bridge.py` remains as a thin shim so existing one-off validation commands do not break
- new workflow or manager integrations should call `scripts/runtime/sense-runtime-tool.sh`

Control plane / runtime plane split:

- T550 OpenClaw = control plane and orchestration
- Sense worker + Sense WSL NemoClaw = runtime plane and execution

Operational notes:

- `401 unauthorized` is returned directly when the shared token is wrong
- `start` may still be functionally limited until provider configuration such as NVIDIA API keys is complete
- `sandbox-status` is still a text-heavy runtime report, but the bridge now strips ANSI and keeps it readable for manager-side consumption

Natural next step:

- wrap `scripts/runtime/sense-runtime-tool.sh` behind a manager or bot tool that maps intents like `sense runtime status` or `sense sandbox status` to the runtime bridge command
