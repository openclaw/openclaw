---
name: openclaw-update-checker
description: Evaluate OpenClaw version/update posture and recommend safe upgrade timing. Use when users ask whether they are up to date, what changed in newer versions, or when to upgrade with minimal disruption.
---

# OpenClaw Update Checker

Assess update status and provide action-oriented guidance.

## Check current posture

Run:

```bash
openclaw update status
openclaw --version
```

## Evaluate upgrade urgency

Classify as:

1. Up to date
2. Update available (non-urgent)
3. Update recommended soon (stability/security reasons)

## Recommended output

Return a concise summary with:

- current version
- update channel/status
- whether update is available
- recommended action now vs later

## Safe upgrade suggestion

Before upgrade, recommend:

1. create verified backup
2. choose a low-traffic window
3. restart gateway and re-check status after update

## Minimal commands to include

```bash
openclaw backup create --verify --output <backup-dir>
openclaw update status
openclaw gateway restart
openclaw status
```

## Guardrails

- Do not force upgrades.
- Keep advice environment-aware (dev vs production-like node).
- If status output is unclear, ask for command output rather than guessing.
