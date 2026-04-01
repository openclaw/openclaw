# Sense WSL Runtime Bridge

This helper is the smallest control-plane bridge from the T550 OpenClaw repo into the Sense runtime plane.

Path:

- `scripts/dev/sense_runtime_bridge.py`

Role:

- submit a Sense `heavy_task` with `mode=nemoclaw_job`
- target the Sense WSL NemoClaw runtime plane through `future-nemoclaw`
- poll `/jobs/{job_id}` until the structured result is ready
- return `401 unauthorized` directly when the shared token is wrong

Typical commands:

```bash
python3 scripts/dev/sense_runtime_bridge.py status \
  --token "$SENSE_WORKER_TOKEN" \
  --input "Fetch Sense WSL runtime status from T550 control plane."

python3 scripts/dev/sense_runtime_bridge.py start \
  --token "$SENSE_WORKER_TOKEN" \
  --input "Start the Sense WSL NemoClaw runtime from T550 control plane."

python3 scripts/dev/sense_runtime_bridge.py sandbox-status \
  --token "$SENSE_WORKER_TOKEN" \
  --sandbox-name sense-wsl-agent \
  --input "Check sandbox state from the control plane."
```

Why this helper lives on T550:

- T550 remains the control plane and orchestration node
- Sense remains the execution node
- the WSL upstream runtime clone stays clean and does not need Deepnoa-specific bridge patches

Natural next step:

- wrap this helper behind a manager / bot / workflow entrypoint once the one-command path is stable
