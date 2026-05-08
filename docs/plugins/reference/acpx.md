---
summary: "Embedded ACP runtime backend with plugin-owned session and transport management."
read_when:
  - You are installing, configuring, or auditing the acpx plugin
title: "ACPx plugin"
---

# ACPx plugin

Embedded ACP runtime backend with plugin-owned session and transport management.

## Distribution

- Package: `@openclaw/acpx`
- Install route: npm; ClawHub

## Surface

skills

## Session ID join model

ACP sessions have two distinct identifiers that refer to the same session:

- **OpenClaw side:** the session-store key (for example `agent:copilot:acp:<uuid>`), used as the key in the sessions store (`~/.openclaw/agents/<agentId>/sessions/sessions.json`).
- **Backend/copilot side:** the `acpxSessionId` stored in `entry.acp.identity.acpxSessionId` inside the session record.

The copilot-side state directory lives at `~/.copilot/session-state/<acpxSessionId>/`.

To print the full triple for every ACP session and check whether the copilot state directories exist on disk, run:

```bash
openclaw sessions link
```

Output columns (TSV, one row per ACP session):

| Column               | Description                                    |
| -------------------- | ---------------------------------------------- |
| `openclaw-key`       | OpenClaw session-store key                     |
| `acp-session-id`     | ACP/copilot-side session id (`acpxSessionId`)  |
| `copilot-state-path` | Resolved `~/.copilot/session-state/<id>/` path |
| `status`             | `ok`, `MISSING_STATE_DIR`, or `MISSING_ACP_ID` |

Use `--json` for machine-readable output. `MISSING_STATE_DIR` means the OpenClaw session record has an `acpxSessionId` but the copilot state directory does not exist. `MISSING_ACP_ID` means the session has ACP metadata but no `acpxSessionId` has been resolved yet (identity still pending).

## Related docs

- [acpx](/tools/acp-agents-setup)
