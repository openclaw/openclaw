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

> **Community skill.** `openclaw-sap-gate` is authored by [@rudi193-cmd](https://github.com/rudi193-cmd) and is not an official OpenClaw package. Review the source at [rudi193-cmd/openclaw-sap-gate](https://github.com/rudi193-cmd/openclaw-sap-gate) before installing.

Enforce [SAP/1.0](https://github.com/rudi193-cmd/sap-rfc) authorization on every MCP tool call. No signed SAFE manifest = no execution.

## Install

```bash
pip install openclaw-sap-gate
```

## Required Setup — Pin Your GPG Key

**You must set `SAP_PGP_FINGERPRINT` before the gate provides meaningful security.** Without it, any valid GPG signature passes regardless of who signed it.

```bash
# Get your primary key fingerprint
gpg --list-keys --fingerprint | grep -A1 pub | grep -v pub | tr -d " "

# Add to your shell profile
export SAP_PGP_FINGERPRINT=<your-40-char-fingerprint>
```

The gate rejects signatures from any key that does not match this fingerprint. Without it the SAFE folder still blocks unsigned calls, but does not verify key ownership.

## How It Works

1. `~/.sap/Applications/<app_id>/` folder exists
2. `safe-app-manifest.json` present and readable
3. `safe-app-manifest.json.sig` present
4. `gpg --verify` confirms signature matches `SAP_PGP_FINGERPRINT`

Any failure → deny + log to `~/.sap/log/gaps.jsonl`. Revocation = delete the folder or the sig file.

## Usage in Code

```python
from openclaw_sap_gate import authorized, require_authorized

if not authorized("my-app"):
    return "denied"

require_authorized("my-app")  # raises PermissionError on failure
```

## Workflow

### On Pass
Proceed normally. Grant logged to `~/.sap/log/grants.jsonl`.

### On Denial
1. Do NOT execute the tool call
2. Surface: > "Tool call denied: `<app_id>` not authorized."
3. Logged to `~/.sap/log/gaps.jsonl`
4. Do not retry without explicit user instruction

## Registering a New App

```bash
sap-gate init <app_id>
$EDITOR ~/.sap/Applications/<app_id>/safe-app-manifest.json
gpg --detach-sign ~/.sap/Applications/<app_id>/safe-app-manifest.json
mv ~/.sap/Applications/<app_id>/safe-app-manifest.json.gpg \
   ~/.sap/Applications/<app_id>/safe-app-manifest.json.sig
sap-gate verify <app_id>
```

## Revoking

```bash
rm ~/.sap/Applications/<app_id>/safe-app-manifest.json.sig  # sig only
rm -rf ~/.sap/Applications/<app_id>/                        # full revoke
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SAP_SAFE_ROOT` | `~/.sap/Applications` | Root for SAFE folders |
| `SAP_PGP_FINGERPRINT` | **required — set this** | Your GPG primary key fingerprint |
| `SAP_LOG_DIR` | `~/.sap/log` | Log directory |

## Protocol Spec

→ [SAP/1.0 RFC](https://github.com/rudi193-cmd/sap-rfc)
