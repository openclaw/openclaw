---
name: caveman-skill
description: "Use the simplest read-only OpenClaw flow: verify repo root, run one next-safe task, and report clear status."
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

# Caveman Skill

Minimal and explicit OpenClaw execution mode for fast, safe closure.

## Use When

- User asks for a simple, direct, low-complexity workflow.
- Need a one-cycle health check without third-party installs.
- Need deterministic read-only output for current automation status.

## Guardrails

- Read-only only.
- Do not login to broker.
- Do not place any order.
- Do not install or execute third-party code.

## Standard Commands

```powershell
pnpm autonomous:controlled:next-safe
pnpm autonomous:controlled:run
```

If controlled runner is missing, fallback commands:

```powershell
pnpm capital-hft:quote:status
pnpm capital-hft:auto-trading-watch:daemon-check
pnpm autonomous:inventory:check
```

## Required Output

- core result
- changed files
- validation result
- remaining blockers
- next safe task
