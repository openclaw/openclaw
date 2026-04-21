---
name: sap-enforcer
description: Enforce SAP/1.0 (SAFE Authorization Protocol) before executing MCP tool calls. Use when you need PGP-signed app identity checks, access denial logging, or revocable authorization for agent-controlled tools.
homepage: https://github.com/rudi193-cmd/sap-rfc
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["gpg"], "python": ["openclaw-sap-gate"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "package": "openclaw-sap-gate",
              "label": "Install SAP gate (pip)",
            },
          ],
      },
  }
---

# SAP Enforcer

Enforce [SAP/1.0](https://github.com/rudi193-cmd/sap-rfc) authorization on every MCP tool call. No signed SAFE manifest = no execution.

## Install

```bash
pip install openclaw-sap-gate
```

## How It Works

Before dispatching any MCP tool call, the gate checks four conditions:

1. `~/.sap/Applications/<app_id>/` folder exists
2. `safe-app-manifest.json` is present and readable
3. `safe-app-manifest.json.sig` is present
4. `gpg --verify` confirms the signature matches the pinned key

Any failure → deny + log to `~/.sap/log/gaps.jsonl`. Revocation = delete the folder or the sig file.

## Usage in Code

```python
from openclaw_sap_gate import authorized, require_authorized

# Check (returns bool)
if not authorized("my-app"):
    return "denied"

# Assert (raises PermissionError on failure)
require_authorized("my-app")
```

## Workflow

### On Authorization Pass

Proceed with the tool call normally. The grant is logged to `~/.sap/log/grants.jsonl`.

### On Authorization Denial

1. Do NOT execute the tool call
2. Surface the failure:
   > "Tool call denied: `<app_id>` is not authorized. Check that its SAFE folder exists and manifest is signed."
3. The denial is logged to `~/.sap/log/gaps.jsonl`
4. Do not retry without explicit user instruction

## Registering a New App

```bash
# 1. Scaffold SAFE folder + manifest template
sap-gate init <app_id>

# 2. Edit the manifest
$EDITOR ~/.sap/Applications/<app_id>/safe-app-manifest.json

# 3. Sign with your GPG key
gpg --detach-sign ~/.sap/Applications/<app_id>/safe-app-manifest.json
mv ~/.sap/Applications/<app_id>/safe-app-manifest.json.gpg    ~/.sap/Applications/<app_id>/safe-app-manifest.json.sig

# 4. Verify
sap-gate verify <app_id>
```

## Revoking Authorization

```bash
# Remove signature only (preserves manifest for re-authorization)
rm ~/.sap/Applications/<app_id>/safe-app-manifest.json.sig

# Revoke completely
rm -rf ~/.sap/Applications/<app_id>/
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SAP_SAFE_ROOT` | `~/.sap/Applications` | Root directory for SAFE folders |
| `SAP_PGP_FINGERPRINT` | *(empty — any valid sig passes)* | Pin a specific GPG key fingerprint |
| `SAP_LOG_DIR` | `~/.sap/log` | Directory for gaps.jsonl and grants.jsonl |

## Protocol Spec

→ [SAP/1.0 RFC](https://github.com/rudi193-cmd/sap-rfc)
