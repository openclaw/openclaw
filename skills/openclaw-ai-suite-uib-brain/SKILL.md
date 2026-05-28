---
name: openclaw-ai-suite-uib-brain
description: "Query OpenClaw AI suite UIB status in a read-only way and return clear blockers plus next safe task."
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node", "pnpm"] },
        "safety":
          {
            "readOnly": true,
            "loginAttempted": false,
            "liveTradingEnabled": false,
            "writeTradingEnabled": false,
          },
      },
  }
---

# OpenClaw AI Suite UIB Brain

Read-only status skill for the UIB flow.

## Use When

- Need one command to understand current automation status.
- Need blockers and next safe task in a stable format.
- Need safe reporting without broker writes.

## Guardrails

- Read-only only.
- No broker login.
- No order placement.
- No third-party install or code execution.

## Command

```powershell
pnpm autonomous:ai-suite:uib:query
```

## Output

- core result
- quote status and market session
- source vetting status
- remaining blockers
- next safe task
