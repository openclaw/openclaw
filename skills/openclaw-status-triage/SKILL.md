---
name: openclaw-status-triage
description: Quick triage workflow for OpenClaw runtime health using `openclaw status`, `openclaw health`, and gateway checks. Use when users report that OpenClaw is down, stuck, disconnected, or behaving unexpectedly.
---

# OpenClaw Status Triage

Run a fast, repeatable first-response diagnostic.

## Core commands

Run in order:

```bash
openclaw status
openclaw health --json
openclaw gateway status
```

If needed:

```bash
openclaw doctor
```

## Triage flow

1. Check whether gateway is running.
2. Check health output for failing components.
3. Identify channel/connectivity failures.
4. Classify issue: service down, auth/session issue, network issue, or config issue.
5. Propose the smallest safe next step.

## Common next actions

- Service down: `openclaw gateway start`
- Hung service: `openclaw gateway restart`
- Config drift: review with `openclaw config validate`
- Channel issue: inspect with `openclaw channels ...` commands relevant to provider

## Reporting format

Return:

- current status summary (1-3 bullets)
- probable root cause
- exact next command
- what to run next if the first fix fails

## Guardrails

- Prefer read-only diagnostics first.
- Ask before disruptive actions (`restart`, `reset`, relogin).
- Do not claim recovery until a follow-up status check passes.
