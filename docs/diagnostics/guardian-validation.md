---
title: Guardian Validation
summary: Validate stable and Guardian gateways side by side with a safe script.
---

# Guardian Validation

This guide explains how to run the Guardian validation script against a stable gateway
on port `18789` and a Guardian gateway on port `19001`. The script is safe and
read-only for config, and it only uses temp files for audit checks.

See [Guardian](/security/guardian) for audit log background and policy details.

## English

### What it does

- Reads config (no writes).
- Calls gateway health, status, system presence, and sessions list.
- Reads a harmless temp file.
- Writes a temp file via apply_patch to confirm audit log entries for both Stable and Guardian.
- Logs latency per action and compares Stable vs Guardian overhead.

### Prerequisites

- Node 22+ with Corepack and pnpm.
- Stable gateway running on `ws://127.0.0.1:18789`.
- Guardian gateway running on `ws://127.0.0.1:19001`.
- Config files exist:
  - `~/.openclaw/openclaw.json`
  - `~/.openclaw-guardian/openclaw.json`
- If both gateways run on the same host, start Guardian with `OPENCLAW_ALLOW_MULTI_GATEWAY=1`.
- Audit test files are created under the temp directory by default.

### Run

```bash
cd <REPO_ROOT>
corepack pnpm exec tsx scripts/guardian-validate.mts
```

### Optional thresholds

The script fails if Guardian overhead is too high. Defaults:

- `GUARDIAN_MAX_OVERHEAD_MS=200`
- `GUARDIAN_MAX_OVERHEAD_PCT=0.3` (30 percent)

Override example:

```bash
GUARDIAN_MAX_OVERHEAD_MS=200 GUARDIAN_MAX_OVERHEAD_PCT=0.3 \
  corepack pnpm exec tsx scripts/guardian-validate.mts
```

PowerShell example:

```powershell
$env:GUARDIAN_MAX_OVERHEAD_MS="200"
$env:GUARDIAN_MAX_OVERHEAD_PCT="0.3"
corepack pnpm exec tsx scripts/guardian-validate.mts
```

### Optional audit location

By default the audit test files are written under the temp directory. To place
them somewhere else (for example, a shared test folder), set:

```bash
GUARDIAN_VALIDATE_AUDIT_DIR="/path/to/folder"
```

PowerShell example:

```powershell
$env:GUARDIAN_VALIDATE_AUDIT_DIR="C:\\Path\\To\\Folder"
```

### Output

- Per action: status and latency.
- Comparison table with delta ms and delta percent.
- Audit log check for both Stable and Guardian.
- Final `PASS` or `FAIL` summary.

### Safety notes

- The script does not write or patch any config files.
- It uses only temp file reads and a temp file write for audit verification.
- It fails if config mtime or size changes.

### Troubleshooting

- `gateway url override requires explicit credentials`  
  Ensure `gateway.auth.token` or `gateway.auth.password` is set in both configs, or
  export `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` before running.

- `gateway already running` when starting Guardian  
  Start Guardian with `OPENCLAW_ALLOW_MULTI_GATEWAY=1` so the gateway lock allows
  two local instances.
