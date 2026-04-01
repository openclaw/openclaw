# Sense Runtime Tool

Formal runtime-plane entrypoints for the T550 control plane live in:

- `scripts/runtime/sense_runtime_bridge.py`
- `scripts/runtime/sense-runtime.sh`

Role:

- submit a Sense `heavy_task` with `mode=nemoclaw_job`
- target the Sense WSL NemoClaw runtime plane through `future-nemoclaw`
- poll `/jobs/{job_id}` until the structured result is ready
- return structured output for `status`, `start`, `stop`, and `sandbox-status`
- return `401 unauthorized` directly when the shared token is wrong

Preferred entrypoint for workflows and manager-side automation:

```bash
scripts/runtime/sense-runtime.sh status --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime.sh start --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime.sh stop --token "$SENSE_WORKER_TOKEN"
scripts/runtime/sense-runtime.sh sandbox-status --token "$SENSE_WORKER_TOKEN" --sandbox-name sense-wsl-agent
```

Compatibility note:

- `scripts/dev/sense_runtime_bridge.py` remains as a thin shim so existing one-off validation commands do not break
- new workflow or manager integrations should call the `scripts/runtime/` entrypoint instead

Control plane / runtime plane split:

- T550 OpenClaw = control plane and orchestration
- Sense worker + Sense WSL NemoClaw = runtime plane and execution

Natural next step:

- wrap `scripts/runtime/sense-runtime.sh` behind a manager or bot tool that maps intent like `sense runtime status` to the bridge command
