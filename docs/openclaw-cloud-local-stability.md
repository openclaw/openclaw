# OpenClaw Cloud + Local Stability Plan

This setup gives you a stable control loop in two layers:

1. Cloud control plane (GitHub Actions)
2. Local execution plane (Windows + WSL + OpenClaw + Edge CDP bridge)

## What was added

- `.github/workflows/agent-cloud-control.yml`
- `scripts/ci/validate_openclaw_stack.py`
- `tools/openclaw-local-guard.ps1`
- `tools/openclaw-cdp-proxy.js`

## Layer 1: Cloud control plane

Workflow: `Agent Cloud Control`

- `cloud-validate` job runs on GitHub-hosted Ubuntu
- validates required control-plane files are present and structurally sane
- runs every 30 minutes and on manual dispatch

Manual run:

1. Open GitHub Actions
2. Select `Agent Cloud Control`
3. Click `Run workflow`

## Layer 2: Local execution plane

Local guard script:

```powershell
powershell -ExecutionPolicy Bypass -File .\\tools\\openclaw-local-guard.ps1 -Action status
powershell -ExecutionPolicy Bypass -File .\\tools\\openclaw-local-guard.ps1 -Action repair
powershell -ExecutionPolicy Bypass -File .\\tools\\openclaw-local-guard.ps1 -Action smoke
```

What `repair` does:

- ensures WSL Ollama service is running
- ensures OpenClaw launch process is running
- ensures Edge starts with remote debugging (`9333`)
- ensures CDP proxy starts (`9334 -> 9333`)

What `smoke` verifies:

- `ollama` API reachable in WSL
- OpenClaw gateway reachable in WSL
- WSL can reach Windows CDP proxy endpoint

## Optional: GitHub-triggered local smoke

If you add a self-hosted runner on your Windows machine with labels:

- `self-hosted`
- `windows`
- `openclaw`

Then `Run workflow` with `run_local_smoke=true` will execute:

```powershell
.\\tools\\openclaw-local-guard.ps1 -Action smoke -JsonOut ".tmp\\openclaw-local-health.json"
```

and upload the JSON health artifact to GitHub Actions.

## Why this closes the loop

- Cloud side continuously validates the control-plane definition.
- Local side can self-repair and output machine-readable health.
- Both sides use repeatable commands with clear pass/fail signals.

This is the minimum stable baseline before adding higher-level task orchestration.
