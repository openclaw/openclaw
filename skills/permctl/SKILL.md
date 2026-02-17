---
name: permctl
description: Check and manage macOS TCC permissions for AI agents. Use when tools fail with permission errors, after installing new CLI tools, or after Node.js upgrades.
metadata: { "openclaw": { "emoji": "🔐", "os": ["darwin"], "requires": { "bins": ["osascript"] } } }
---

# permctl — macOS TCC Permission Checker

Self-contained bash script. No dependencies beyond macOS builtins.

## Location

The script is bundled at `permctl.sh` next to this file. Resolve the path relative to this SKILL.md.

## Commands

All output is JSON. Parse with `jq` or inline.

### Check permissions (agent-relevant)

```bash
bash <SKILL_DIR>/permctl.sh status
```

Returns:

```json
{
  "binary": "/opt/homebrew/Cellar/node/25.4.0/bin/node",
  "permissions": [
    { "kind": "screen-recording", "status": "granted" },
    { "kind": "accessibility", "status": "granted" },
    { "kind": "automation", "status": "granted" },
    { "kind": "full-disk-access", "status": "granted" }
  ]
}
```

Status values: `granted` | `denied` | `unknown`

### Check all permissions (including calendar, reminders)

```bash
bash <SKILL_DIR>/permctl.sh status --all
```

### Trigger popup for a missing permission

```bash
bash <SKILL_DIR>/permctl.sh request screen-recording
```

Returns `{"kind":"screen-recording","triggered":true}` or `{"triggered":false,"opened_settings":true}` for permissions that require manual setup.

### Batch-request all missing

```bash
bash <SKILL_DIR>/permctl.sh request
```

Checks all agent permissions, triggers popups for denied ones, opens System Settings for manual-only ones.

### Open System Settings panel

```bash
bash <SKILL_DIR>/permctl.sh guide accessibility
```

Available permission names: `screen-recording`, `accessibility`, `automation`, `full-disk-access`, `camera`, `microphone`, `calendar`, `reminders`, `contacts`, `input-monitoring`

## Decision Logic for Agents

```
1. Tool fails with permission error
2. Run: bash permctl.sh status
3. Parse JSON → find denied/unknown permissions
4. For each denied:
   a. Run: bash permctl.sh request <permission>
   b. If triggered=false → tell user to grant manually in System Settings
5. Retry the original tool
```

## Why Permissions Break

macOS TCC is per-binary. The **node binary** needs permissions, not CLI tools.
After `brew upgrade node`, the path changes → permissions invalidated → run `permctl.sh status` to diagnose.

## Related Tools

| Tool                | Needs                           |
| ------------------- | ------------------------------- |
| Peekaboo            | screen-recording, accessibility |
| macos-automator-mcp | automation, accessibility       |
| camsnap             | camera                          |
| whisper / sag       | microphone                      |
