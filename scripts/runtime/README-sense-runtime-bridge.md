# Sense Runtime Tool

Formal runtime-plane entrypoints for the T550 control plane live in:

- `scripts/runtime/sense_runtime_bridge.py`
- `scripts/runtime/sense-runtime.sh`
- `scripts/runtime/sense-runtime-tool.sh`
- `scripts/runtime/sense-runtime-intent.sh`
- `scripts/runtime/sense_runtime_subprocess_tool.py`
- `scripts/runtime/sense-runtime-subprocess-tool.sh`

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
  - intent mapper for manager / bot / workflow
  - turns natural control-plane intents into runtime actions
- `sense_runtime_subprocess_tool.py`
  - manager-facing subprocess wrapper with explicit `--action`
  - safely builds argv and delegates to `sense-runtime-intent.sh`
- `sense-runtime-subprocess-tool.sh`
  - executable shell entrypoint for manager / bot / workflow subprocess calls

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
scripts/runtime/sense-runtime-subprocess-tool.sh --action status --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-subprocess-tool.sh --action start --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-subprocess-tool.sh --action stop --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime-subprocess-tool.sh --action sandbox-status --token "$SENSE_WORKER_TOKEN" --sandbox-name sense-wsl-agent
```

Compatibility note:

- `scripts/dev/sense_runtime_bridge.py` remains as a thin shim so existing one-off validation commands do not break
- natural-language routing can keep calling `scripts/runtime/sense-runtime-intent.sh`
- manager / bot / workflow integrations should prefer `scripts/runtime/sense-runtime-subprocess-tool.sh`
- `scripts/runtime/sense-runtime-tool.sh` remains the stable execution boundary for result-only JSON

Control plane / runtime plane split:

- T550 OpenClaw = control plane and orchestration
- Sense worker + Sense WSL NemoClaw = runtime plane and execution

Subprocess tool path:

- manager / bot / workflow
- -> `scripts/runtime/sense-runtime-subprocess-tool.sh`
- -> `scripts/runtime/sense_runtime_subprocess_tool.py`
- -> `scripts/runtime/sense-runtime-intent.sh`
- -> `scripts/runtime/sense-runtime-tool.sh`
- -> `scripts/runtime/sense_runtime_bridge.py`
- -> Sense worker
- -> `nemoclaw_runner.py`
- -> Sense WSL NemoClaw runtime

Operational notes:

- `401 unauthorized` is returned directly when the shared token is wrong
- `start` may still be functionally limited until provider configuration such as NVIDIA API keys is complete
- `sandbox-status` is still a text-heavy runtime report, but the bridge now strips ANSI and keeps it readable for manager-side consumption
- if manager or bot needs richer sandbox fields later, `sandbox-status` can be further structured without changing the bridge path
